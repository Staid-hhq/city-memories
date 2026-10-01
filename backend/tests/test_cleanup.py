"""T10 destructive checks operate exclusively on temporary synthetic fixtures."""

import asyncio
import io
import os
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.exc import OperationalError
from starlette.requests import Request
from test_auth import csrf
from test_auth import environment as environment
from test_imports import commit, picture_bytes, start, upload
from test_process_restart import running_server
from test_trash import change, read
from test_trash import collection as collection

from city_memories.cleanup import CleanupService, InstanceLock, ManagedDirectory
from city_memories.imports import DAY, LEASE
from city_memories.main import create_app
from city_memories.models import AuthRateLimit, ImportBatch, LoginSession, Photo, UploadItem
from city_memories.storage import private_path
from city_memories.trash import RETENTION_MS


def item_for(app, batch):
    with app.state.auth.sessions() as db:
        return db.get(UploadItem, batch["items"][0]["id"])


def original_for(app, settings, photo_id):
    with app.state.auth.sessions() as db:
        return private_path(settings.originals_dir, db.get(Photo, photo_id).storage_key)


def due_photo(app, photo_id, now, state="trashed"):
    with app.state.auth.sessions.begin() as db:
        photo = db.get(Photo, photo_id)
        photo.state, photo.position = state, None
        photo.deleted_at, photo.purge_after = now - RETENTION_MS, now


@pytest.mark.parametrize("offset", [-1, 0, 1])
def test_exact_expiry_only_removes_due_copy_and_keeps_receipt(collection, offset):
    app, client, settings, now, _, album, ids, contents = collection
    path = original_for(app, settings, ids[0])
    with app.state.auth.sessions() as db:
        item = db.get(UploadItem, db.get(Photo, ids[0]).upload_item_id)
        batch_id = item.batch_id
        receipt = db.get(ImportBatch, batch_id).commit_result_json
    due_photo(app, ids[0], now[0] - offset)
    report = app.state.cleanup.run_once()
    assert report.failures == 0
    assert report.photos_removed == int(offset >= 0)
    assert path.exists() == (offset < 0)
    with app.state.auth.sessions() as db:
        assert (db.get(Photo, ids[0]) is None) == (offset >= 0)
        assert db.get(UploadItem, item.id).state == "committed"
        assert db.get(ImportBatch, batch_id).commit_result_json == receipt
    replay = client.post(
        f"/api/v1/imports/{batch_id}/commit",
        headers=csrf(client),
        json={"expected_album_revision": 1},
    )
    assert replay.status_code == 200 and replay.json()["data"]["photo_ids"] == ids
    assert path.exists() == (offset < 0)
    assert read(client, f"/albums/{album}")["photo_count"] == 2
    for photo_id, content in zip(ids[1:], contents[1:], strict=True):
        assert original_for(app, settings, photo_id).read_bytes() == content


def test_file_failure_retains_purging_metadata_retries_and_does_not_starve(
    collection, monkeypatch, caplog
):
    app, client, settings, now, _, _, ids, _ = collection
    paths = [original_for(app, settings, photo) for photo in ids]
    for photo in ids[:2]:
        due_photo(app, photo, now[0])
    actual = ManagedDirectory.unlink

    def fail(self, name):
        if name == paths[0].name:
            raise PermissionError("private-filename-and-secret-must-not-appear")
        return actual(self, name)

    with monkeypatch.context() as patch:
        patch.setattr(ManagedDirectory, "unlink", fail)
        report = app.state.cleanup.run_once()
    assert report.failures == 1 and report.photos_removed == 1
    assert "private-filename-and-secret-must-not-appear" not in caplog.text
    assert paths[0].name not in caplog.text
    with app.state.auth.sessions() as db:
        assert db.get(Photo, ids[0]).state == "purging"
        assert db.get(Photo, ids[1]) is None
    assert paths[0].exists() and paths[2].exists() and not paths[1].exists()
    assert (
        change(
            client, ids[0], restore=True, expected_photo_revision=2, expected_album_revision=2
        ).status_code
        == 410
    )
    assert app.state.cleanup.run_once().photos_removed == 1
    assert not paths[0].exists()


@pytest.mark.parametrize("fail_at", ["mark", "delete"])
def test_database_failure_before_or_after_unlink_resumes_safely(collection, fail_at):
    app, _, settings, now, _, _, ids, _ = collection
    path = original_for(app, settings, ids[0])
    due_photo(app, ids[0], now[0])

    def fail(conn, cursor, statement, parameters, context, many):
        if statement.startswith(
            "UPDATE photos SET state=" if fail_at == "mark" else "DELETE FROM photos"
        ):
            raise OperationalError(statement, parameters, Exception("synthetic failure"))

    event.listen(app.state.engine, "before_cursor_execute", fail)
    try:
        assert app.state.cleanup.run_once().failures == 1
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail)
    assert path.exists() == (fail_at == "mark")
    with app.state.auth.sessions() as db:
        assert db.get(Photo, ids[0]).state == ("trashed" if fail_at == "mark" else "purging")
    # A fresh maintenance object also completes after loss of all in-memory state.
    assert CleanupService(app.state.imports).run_once().photos_removed == 1
    assert not path.exists()


@pytest.mark.parametrize("winner", ["restore", "cleanup"])
def test_restore_cleanup_race_never_removes_a_restored_file(collection, monkeypatch, winner):
    app, client, settings, now, _, _, ids, contents = collection
    photo_id = ids[0]
    path = original_for(app, settings, photo_id)
    due_photo(app, photo_id, now[0] + (1 if winner == "restore" else 0))
    reached, resume = threading.Event(), threading.Event()
    if winner == "restore":
        actual = app.state.cleanup._photos

        def pause(report):
            reached.set()
            assert resume.wait(5)
            actual(report)

        monkeypatch.setattr(app.state.cleanup, "_photos", pause)
    else:
        actual = app.state.cleanup.originals.unlink

        def pause(name):
            reached.set()
            assert resume.wait(5)
            return actual(name)

        monkeypatch.setattr(app.state.cleanup.originals, "unlink", pause)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(app.state.cleanup.run_once)
        try:
            assert reached.wait(5)
            result = change(
                client, photo_id, restore=True, expected_photo_revision=1, expected_album_revision=2
            )
            assert result.status_code == (200 if winner == "restore" else 410)
            now[0] += 1
        finally:
            resume.set()
        assert future.result(timeout=5).failures == 0
    if winner == "restore":
        assert path.read_bytes() == contents[0]
        assert read(client, f"/photos/{photo_id}")["ordinal"] == 3
    else:
        assert not path.exists()


def test_stale_lease_and_attempt_files_never_overwrite_a_new_attempt(collection):
    app, client, settings, now, owner, album, _, _ = collection
    content = picture_bytes()
    batch = start(client, album, content).json()["data"]
    service = app.state.imports
    item, token = service.begin_upload(batch["id"], batch["items"][0]["id"], owner)
    old = private_path(settings.staging_dir, item.storage_key, token)
    old.write_bytes(b"synthetic interrupted transfer")
    assert app.state.cleanup.run_once().leases_failed == 0 and old.exists()
    now[0] += LEASE
    report = app.state.cleanup.run_once()
    assert report.leases_failed == 1 and not old.exists()
    assert (
        read(client, f"/imports/{batch['id']}")["items"][0]["failure_code"]
        == "UPLOAD_ATTEMPT_EXPIRED"
    )
    fresh, fresh_token = service.begin_upload(batch["id"], item.id, owner)
    service.receive(batch["id"], fresh, owner, fresh_token, io.BytesIO(content))
    with pytest.raises(Exception, match="UPLOAD_ATTEMPT_EXPIRED") as failure:
        service.receive(batch["id"], item, owner, token, io.BytesIO(content))
    assert failure.value.code == "UPLOAD_ATTEMPT_EXPIRED"
    app.state.cleanup.run_once()
    assert private_path(settings.staging_dir, item.storage_key).read_bytes() == content
    assert commit(client, batch).status_code == 200


def test_cleanup_while_old_upload_finishes_cannot_publish_or_delete_new_attempt(
    collection, monkeypatch
):
    app, client, settings, now, owner, album, _, _ = collection
    from city_memories import imports as module

    content = picture_bytes()
    batch = start(client, album, content).json()["data"]
    item, old_token = app.state.imports.begin_upload(batch["id"], batch["items"][0]["id"], owner)
    ready, resume = threading.Event(), threading.Event()
    actual = module.write_and_validate

    def delayed(stream, target, expected_bytes, expected_hash):
        result = actual(stream, target, expected_bytes, expected_hash)
        if old_token in target.name:
            ready.set()
            assert resume.wait(5)
        return result

    monkeypatch.setattr(module, "write_and_validate", delayed)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(
            app.state.imports.receive, batch["id"], item, owner, old_token, io.BytesIO(content)
        )
        try:
            assert ready.wait(5)
            now[0] += LEASE
            assert app.state.cleanup.run_once().leases_failed == 1
            fresh, token = app.state.imports.begin_upload(batch["id"], item.id, owner)
            app.state.imports.receive(batch["id"], fresh, owner, token, io.BytesIO(content))
        finally:
            resume.set()
        with pytest.raises(Exception) as failure:
            future.result(timeout=5)
        assert failure.value.code == "UPLOAD_ATTEMPT_EXPIRED"
    assert private_path(settings.staging_dir, item.storage_key).read_bytes() == content


def test_expired_and_canceled_batches_cleanup_but_keep_metadata(collection, monkeypatch):
    app, client, settings, now, _, album, _, _ = collection
    batches, paths = [], []
    for _ in range(2):
        batch = start(client, album, picture_bytes()).json()["data"]
        assert upload(client, batch, picture_bytes()).status_code == 200
        item = item_for(app, batch)
        paths.append(private_path(settings.staging_dir, item.storage_key))
        batches.append(batch)
    from city_memories import imports as module

    monkeypatch.setattr(module, "remove_temporary", lambda path: None)
    assert (
        client.delete(f"/api/v1/imports/{batches[0]['id']}", headers=csrf(client)).status_code
        == 204
    )
    with app.state.auth.sessions.begin() as db:
        db.get(ImportBatch, batches[1]["id"]).expires_at = now[0] + 1
    now[0] += 1
    report = app.state.cleanup.run_once()
    assert report.imports_expired == 1 and report.files_removed == 2
    assert not any(path.exists() for path in paths)
    assert client.get(f"/api/v1/imports/{batches[1]['id']}").status_code == 410
    assert commit(client, batches[1]).status_code == 410
    with app.state.auth.sessions() as db:
        assert db.get(ImportBatch, batches[0]["id"]).state == "canceled"
        assert db.get(ImportBatch, batches[1]["id"]).state == "expired"
        assert all(
            db.get(UploadItem, batch["items"][0]["id"]).state == "discarded" for batch in batches
        )


def test_half_published_original_survives_cleanup_and_commit_retry(collection):
    app, client, settings, _, _, album, _, _ = collection
    batch = start(client, album, picture_bytes()).json()["data"]
    assert upload(client, batch, picture_bytes()).status_code == 200
    item = item_for(app, batch)

    def fail(conn, cursor, statement, parameters, context, many):
        if statement.startswith("INSERT INTO photos"):
            raise OperationalError(statement, parameters, Exception("synthetic rollback"))

    event.listen(app.state.engine, "before_cursor_execute", fail)
    try:
        assert commit(client, batch).status_code == 503
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail)
    path = private_path(settings.originals_dir, item.storage_key)
    assert path.read_bytes() == picture_bytes()
    assert app.state.cleanup.run_once().files_removed == 0
    assert commit(client, batch).status_code == 200
    assert path.read_bytes() == picture_bytes()


def test_cleanup_does_not_race_import_file_publication(collection, monkeypatch):
    app, client, settings, _, _, album, _, _ = collection
    from city_memories import imports as module

    batch = start(client, album, picture_bytes()).json()["data"]
    upload(client, batch, picture_bytes())
    ready, resume = threading.Event(), threading.Event()
    actual = module.os.replace

    def delayed(source, target):
        actual(source, target)
        ready.set()
        assert resume.wait(5)

    monkeypatch.setattr(module.os, "replace", delayed)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(commit, client, batch)
        try:
            assert ready.wait(5)
            report = app.state.cleanup.run_once()
            assert report.busy and report.files_removed == 0
        finally:
            resume.set()
        assert future.result(timeout=5).status_code == 200
    assert private_path(settings.originals_dir, item_for(app, batch).storage_key).exists()


def test_auth_cleanup_removes_only_expired_or_revoked_records(collection):
    app, client, _, now, _, _, _, _ = collection
    with app.state.auth.sessions.begin() as db:
        for token, expiry, revoked in [
            ("expired", now[0], None),
            ("revoked", now[0] + DAY, now[0]),
            ("valid", now[0] + DAY, None),
        ]:
            db.add(
                LoginSession(
                    token_hash=token,
                    user_id=None,
                    csrf_token="synthetic",
                    created_at=now[0] - DAY,
                    expires_at=expiry,
                    last_seen_at=now[0],
                    revoked_at=revoked,
                )
            )
        for name, expiry in [("expired", now[0]), ("valid", now[0] + DAY)]:
            db.add(
                AuthRateLimit(
                    scope="cleanup-test",
                    key_hash=name,
                    window_start=now[0] - DAY,
                    attempts=3,
                    expires_at=expiry,
                )
            )
    report = app.state.cleanup.run_once()
    assert report.sessions_removed >= 2 and report.rate_limits_removed == 1
    assert client.get("/api/v1/auth/me").status_code == 200
    with app.state.auth.sessions() as db:
        assert db.get(LoginSession, "valid") and db.get(LoginSession, "expired") is None
        assert db.get(LoginSession, "revoked") is None
        assert db.get(AuthRateLimit, ("cleanup-test", "valid", now[0] - DAY)).attempts == 3


def test_orphan_grace_period_unknown_names_nested_files_and_live_photos(collection):
    app, _, settings, now, _, _, ids, contents = collection
    old = settings.originals_dir / uuid4().hex
    recent = settings.originals_dir / uuid4().hex
    strange = settings.staging_dir / "do-not-touch.txt"
    nested = settings.originals_dir / uuid4().hex
    nested.mkdir()
    (nested / uuid4().hex).write_bytes(b"not a direct managed file")
    for path in (old, recent, strange):
        path.write_bytes(b"synthetic orphan")
    os.utime(old, (now[0] / 1000 - DAY / 1000, now[0] / 1000 - DAY / 1000))
    os.utime(recent, (now[0] / 1000, now[0] / 1000))
    app.state.cleanup.run_once()
    assert not old.exists() and recent.exists() and strange.exists() and nested.is_dir()
    assert all(
        original_for(app, settings, photo).read_bytes() == content
        for photo, content in zip(ids, contents, strict=True)
    )


def test_hardlink_and_root_replacement_are_refused_without_touching_source(collection):
    app, _, settings, now, _, _, ids, contents = collection
    outside = settings.data_dir / "synthetic-source.png"
    outside.write_bytes(b"independent source")
    linked = settings.staging_dir / uuid4().hex
    os.link(outside, linked)
    os.utime(outside, (0, 0))
    report = app.state.cleanup.run_once()
    assert (
        report.failures >= 1 and linked.exists() and outside.read_bytes() == b"independent source"
    )
    path = original_for(app, settings, ids[0])
    due_photo(app, ids[0], now[0])
    retained = settings.data_dir / "synthetic-retained-originals"
    settings.originals_dir.rename(retained)
    settings.originals_dir.mkdir()
    replacement = settings.originals_dir / path.name
    replacement.write_bytes(b"not the original directory")
    assert app.state.cleanup.run_once().failures >= 1
    assert replacement.exists() and (retained / path.name).read_bytes() == contents[0]


def test_single_instance_guard_and_reacquisition(collection):
    _, _, settings, _, _, _, _, _ = collection
    with InstanceLock(settings.data_dir):
        with pytest.raises(RuntimeError, match="只能运行一个"):
            with InstanceLock(settings.data_dir):
                pass
    with InstanceLock(settings.data_dir):
        pass


def test_startup_periodic_cleanup_failure_retry_and_shutdown(collection, monkeypatch):
    app, client, settings, _, owner, album, ids, _ = collection
    due_photo(app, ids[0], time.time_ns() // 1_000_000)
    batch = start(client, album, picture_bytes()).json()["data"]
    item, token = app.state.imports.begin_upload(batch["id"], batch["items"][0]["id"], owner)
    part = private_path(settings.staging_dir, item.storage_key, token)
    part.write_bytes(b"interrupted process")
    monkeypatch.setattr("city_memories.main.InstanceLock", InstanceLock)
    enabled = settings.model_copy(update={"cleanup_enabled": True, "cleanup_interval_seconds": 1})
    with TestClient(create_app(enabled)) as restarted:
        service = restarted.app.state.cleanup
        assert service.last_report.photos_removed == 1 and not part.exists()
        with app.state.auth.sessions() as db:
            assert db.get(UploadItem, item.id).failure_code == "INTERRUPTED"
        with pytest.raises(RuntimeError, match="只能运行一个"):
            with TestClient(create_app(enabled)):
                pass
        reached = threading.Event()
        actual = service._photos
        calls = []

        def fail_once(report):
            calls.append(1)
            if len(calls) == 1:
                raise OSError("synthetic first tick failure")
            actual(report)
            reached.set()

        monkeypatch.setattr(service, "_photos", fail_once)
        due_photo(app, ids[1], time.time_ns() // 1_000_000)
        assert reached.wait(5)
        with app.state.auth.sessions() as db:
            assert db.get(Photo, ids[1]) is None and db.get(Photo, ids[2]).state == "active"
    assert not service.thread.is_alive()
    with InstanceLock(settings.data_dir):
        pass


def test_real_process_restart_finishes_purging_with_and_without_file(collection):
    app, _, settings, now, _, _, ids, contents = collection
    missing = original_for(app, settings, ids[1])
    for photo in ids[:2]:
        due_photo(app, photo, now[0], state="purging")
    missing.unlink()  # Synthetic crash after unlink but before database deletion.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = os.environ | {
        "CITY_MEMORIES_DATA_DIR": str(settings.data_dir),
        "CITY_MEMORIES_CLEANUP_ENABLED": "true",
        "CITY_MEMORIES_ALLOWED_ORIGINS": f'["http://127.0.0.1:{port}"]',
    }
    with running_server(port, env):
        with app.state.auth.sessions() as db:
            assert db.get(Photo, ids[0]) is None and db.get(Photo, ids[1]) is None
        assert original_for(app, settings, ids[2]).read_bytes() == contents[2]
    with running_server(port, env):
        assert original_for(app, settings, ids[2]).read_bytes() == contents[2]


def test_stalled_multipart_times_out_closes_spool_and_releases_slots(collection, monkeypatch):
    app, client, _, _, owner, album, _, _ = collection
    from city_memories import imports as module

    batch = start(client, album, picture_bytes()).json()["data"]
    monkeypatch.setattr(module, "LEASE", 30)
    parser_instances = []

    class TrackingParser(module.BoundedMultipartParser):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            parser_instances.append(self)

    monkeypatch.setattr(module, "BoundedMultipartParser", TrackingParser)

    async def check():
        first = True

        async def receive():
            nonlocal first
            if first:
                first = False
                return {
                    "type": "http.request",
                    "more_body": True,
                    "body": (
                        b'--fixture\r\nContent-Disposition: form-data; name="file"; '
                        b'filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\npartial'
                    ),
                }
            await asyncio.sleep(2)
            raise AssertionError("timeout failed")

        request = Request(
            {
                "type": "http",
                "app": app,
                "method": "PUT",
                "headers": [(b"content-type", b"multipart/form-data; boundary=fixture")],
            },
            receive,
        )
        with pytest.raises(Exception) as failure:
            await module.upload_content(
                batch["id"], batch["items"][0]["id"], request, SimpleNamespace(id=owner)
            )
        assert failure.value.code == "UPLOAD_ATTEMPT_EXPIRED"

    asyncio.run(check())
    assert parser_instances[0]._files_to_close_on_error
    assert all(file.closed for file in parser_instances[0]._files_to_close_on_error)
    assert item_for(app, batch).state == "failed"
    assert app.state.imports.slots.acquire(blocking=False)
    assert app.state.imports.slots.acquire(blocking=False)
    app.state.imports.slots.release()
    app.state.imports.slots.release()
    monkeypatch.setattr(module, "LEASE", LEASE)
    assert upload(client, batch, picture_bytes()).status_code == 200


def test_cleanup_bounds_progress_and_does_not_repeat_overlapping_pass(collection, monkeypatch):
    app, _, settings, now, _, _, ids, _ = collection
    from city_memories import cleanup as module

    monkeypatch.setattr(module, "ROW_LIMIT", 1)
    monkeypatch.setattr(module, "SCAN_LIMIT", 2)
    paths = [original_for(app, settings, photo) for photo in ids]
    for photo in ids:
        due_photo(app, photo, now[0])
    actual = ManagedDirectory.unlink

    def fail(self, name):
        if name == paths[0].name:
            raise PermissionError("synthetic locked file")
        return actual(self, name)

    monkeypatch.setattr(ManagedDirectory, "unlink", fail)
    for _ in range(8):
        report = app.state.cleanup.run_once()
        assert report.photos_marked <= 1 and report.photos_removed <= 1
    assert paths[0].exists() and not paths[1].exists() and not paths[2].exists()
    with app.state.cleanup.lock:
        assert app.state.cleanup.run_once().busy


def test_directory_junction_is_not_traversed(collection):
    _, _, settings, _, _, _, _, _ = collection
    if os.name != "nt":
        pytest.skip("Windows junction coverage")
    source = settings.data_dir / "synthetic-external-source"
    source.mkdir()
    untouched = source / uuid4().hex
    untouched.write_bytes(b"never traverse this directory")
    linked = settings.staging_dir / uuid4().hex
    # Both fixed-name directories are inside this test's own temporary root.
    subprocess.run(
        ["cmd.exe", "/d", "/c", "mklink", "/J", str(linked), str(source)],
        check=True,
        capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        assert linked.is_junction()
        with pytest.raises(OSError):
            ManagedDirectory(linked)
        with pytest.raises(OSError):
            ManagedDirectory(settings.staging_dir).unlink(linked.name)
        assert untouched.read_bytes() == b"never traverse this directory"
    finally:
        linked.rmdir()  # Remove only the synthetic junction, never recursively.


def test_disabled_cleanup_still_enforces_one_service_instance(collection, monkeypatch):
    _, _, settings, _, _, _, _, _ = collection
    monkeypatch.setattr("city_memories.main.InstanceLock", InstanceLock)
    with TestClient(create_app(settings)) as single:
        assert single.app.state.cleanup.thread is None
        with pytest.raises(RuntimeError, match="只能运行一个"):
            with TestClient(create_app(settings)):
                pass


def test_partial_commit_discards_only_unpublished_copies_and_keeps_receipt(collection):
    app, client, settings, _, _, album, _, _ = collection
    from test_imports import metadata

    content = picture_bytes()
    batch = client.post(
        f"/api/v1/albums/{album}/imports",
        headers={**csrf(client), "Idempotency-Key": str(uuid4())},
        json={"items": [metadata(content, "kept.png"), metadata(content, "discarded.png")]},
    ).json()["data"]
    assert upload(client, batch, content).status_code == 200
    with app.state.auth.sessions() as db:
        abandoned = db.get(UploadItem, batch["items"][1]["id"])
    paths = [
        private_path(directory, abandoned.storage_key)
        for directory in (settings.staging_dir, settings.originals_dir)
    ]
    for path in paths:
        path.write_bytes(b"synthetic unfinished private copy")
    receipt = commit(client, batch, partial=True).json()["data"]
    report = app.state.cleanup.run_once()
    assert report.files_removed == 2 and not any(path.exists() for path in paths)
    assert original_for(app, settings, receipt["photo_ids"][0]).read_bytes() == content
    assert commit(client, batch, partial=True).json()["data"] == receipt
    assert item_for(app, batch).state == "committed"
    with app.state.auth.sessions() as db:
        assert db.get(UploadItem, abandoned.id).state == "discarded"
