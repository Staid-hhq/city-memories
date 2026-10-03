"""T11: isolated databases, synthetic pictures, never user data or real backup media."""

import hashlib
import json
import os
import socket
import sqlite3
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from photo_fixtures import seed_copies, seed_photos
from test_albums import GUANGZHOU, create, signed_in
from test_auth import COOKIE_NAME, csrf, login
from test_auth import environment as environment
from test_cleanup import due_photo, original_for
from test_imports import picture_bytes, start, upload
from test_process_restart import running_server
from test_trash import change, read
from test_trash import collection as collection

from city_memories import backup
from city_memories.backup import (
    BACKUP_MANIFEST,
    DATABASE_NAME,
    INCOMPLETE_MARKER,
    BackupError,
    create_backup,
    restore_backup,
    verify_backup,
)
from city_memories.cleanup import InstanceLock
from city_memories.main import create_app
from city_memories.models import ImportBatch, Photo, UploadItem


@pytest.fixture
def outputs(tmp_path_factory):
    root = tmp_path_factory.mktemp("t11-private-outputs")
    return root / "snapshot.cmbackup", root / "recovered.cmrestore"


def db_rows(path, table):
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        return sorted(
            (dict(row) for row in db.execute(f'SELECT * FROM "{table}"')),
            key=lambda row: json.dumps(row, sort_keys=True),
        )


def load_manifest(root):
    return json.loads((root / BACKUP_MANIFEST).read_text(encoding="utf-8"))


def update_manifest(root, callback):
    path = root / BACKUP_MANIFEST
    value = load_manifest(root)
    callback(value)
    path.write_text(json.dumps(value), encoding="utf-8")  # Synthetic corrupt fixture only.


def refresh_db_hash(root):
    path = root / "database" / DATABASE_NAME
    update_manifest(
        root,
        lambda value: value.update(
            database={
                "byte_size": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        ),
    )


def settings_at(settings, root):
    return settings.model_copy(update={"data_dir": root, "cleanup_enabled": False})


def test_roundtrip_accounts_ownership_notes_order_duplicates_and_old_sessions(collection, outputs):
    app, client, settings, now, owner, album, ids, contents = collection
    snapshot, restored = outputs
    other = TestClient(app)
    signed_in(other, "Backup_Other")
    second_owner = read(other, "/auth/me")["id"]
    second_album = create(other, None, city=GUANGZHOU).json()["data"]["id"]
    others, _ = seed_photos(app, second_owner, second_album, 1)
    create(client, 1999)  # An empty album is also part of the backup.
    copies = seed_copies(app, owner, album, [contents[0]], ["duplicate.png"])
    assert (
        client.patch(
            f"/api/v1/photos/{ids[0]}/note",
            headers=csrf(client),
            json={"note": "备份的文字 🌅\n第二行", "expected_photo_revision": 1},
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/v1/albums/{album}/reorder",
            headers=csrf(client),
            json={
                "photo_id": copies[0],
                "before_photo_id": ids[0],
                "expected_album_revision": read(client, f"/albums/{album}")["revision"],
            },
        ).status_code
        == 200
    )
    assert change(client, ids[1]).status_code == 200
    cookie = client.cookies[COOKIE_NAME]
    before = {
        table: db_rows(settings.database_path, table)
        for table in ("users", "albums", "photos", "import_batches", "upload_items", "sessions")
    }
    secret = (settings.data_dir / "auth-secret.key").read_bytes()
    summary = create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    assert summary["users"] == 2 and summary["albums"] == 3
    assert summary["active_photos"] == 4 and summary["trashed_photos"] == 1
    assert verify_backup(snapshot) == summary
    assert not (snapshot / "auth-secret.key").exists()
    assert not (snapshot / "staging").exists()
    assert db_rows(snapshot / "database" / DATABASE_NAME, "sessions") == []
    for table, rows in before.items():
        assert db_rows(settings.database_path, table) == rows
    result = restore_backup(snapshot, restored, clock=lambda: now[0] + 100)
    assert result["sessions_invalidated"] and result["expired_excluded"] == 0
    for table in ("users", "albums", "photos", "import_batches", "upload_items"):
        assert db_rows(restored / "database" / DATABASE_NAME, table) == before[table]
    with TestClient(create_app(settings_at(settings, restored))) as recovered:
        recovered.app.state.auth.clock = lambda: now[0] + 100
        recovered.cookies.set(COOKIE_NAME, cookie)
        assert recovered.get("/api/v1/auth/me").status_code == 401
        assert login(recovered, "Album_Traveler").status_code == 200
        assert read(recovered, f"/photos/{ids[0]}")["note"] == "备份的文字 🌅\n第二行"
        assert read(recovered, f"/albums/{album}/photos")["items"][0]["id"] == copies[0]
        assert recovered.get(f"/api/v1/photos/{others[0]}/original").status_code == 404
        assert recovered.get(f"/api/v1/photos/{ids[0]}/original").content == contents[0]
        trash = read(recovered, f"/trash/photos/{ids[1]}")
        assert (
            trash["purge_after"]
            == before["photos"][
                next(i for i, row in enumerate(before["photos"]) if row["id"] == ids[1])
            ]["purge_after"]
        )
        assert change(recovered, ids[1], restore=True).status_code == 200
    assert (restored / "auth-secret.key").read_bytes() != secret
    assert verify_backup(snapshot) == summary  # Restore never changes the backup.


def test_backup_excludes_due_and_purging_without_touching_source_or_receipts(collection, outputs):
    app, client, settings, now, _, _, ids, contents = collection
    snapshot, restored = outputs
    for photo_id, state in zip(ids[:2], ("trashed", "purging"), strict=True):
        due_photo(app, photo_id, now[0], state)
    originals = [original_for(app, settings, photo_id) for photo_id in ids]
    with app.state.auth.sessions() as db:
        batch_id = db.get(UploadItem, db.get(Photo, ids[0]).upload_item_id).batch_id
        receipt = db.get(ImportBatch, batch_id).commit_result_json
    result = create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    assert result["active_photos"] == 1 and result["trashed_photos"] == 0
    assert all(
        path.read_bytes() == content for path, content in zip(originals, contents, strict=True)
    )
    restore_backup(snapshot, restored, clock=lambda: now[0])
    with TestClient(create_app(settings_at(settings, restored))) as recovered:
        recovered.app.state.auth.clock = lambda: now[0]
        login(recovered, "Album_Traveler")
        replay = recovered.post(
            f"/api/v1/imports/{batch_id}/commit",
            headers=csrf(recovered),
            json={"expected_album_revision": 1},
        )
        assert replay.status_code == 200 and replay.json()["data"] == json.loads(receipt)
        assert recovered.get(f"/api/v1/photos/{ids[0]}/original").status_code == 404
        assert recovered.get(f"/api/v1/trash/photos/{ids[1]}").status_code == 404
    assert len(list((restored / "originals").iterdir())) == 1


@pytest.mark.parametrize("offset", [-1, 0, 1])
def test_restore_rechecks_exact_expiry_without_extending_retention(collection, outputs, offset):
    app, _, settings, now, _, _, ids, _ = collection
    snapshot, restored = outputs
    due_photo(app, ids[0], now[0] + 100)
    before = db_rows(settings.database_path, "photos")
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    result = restore_backup(snapshot, restored, clock=lambda: now[0] + 100 + offset)
    assert result["expired_excluded"] == int(offset >= 0)
    rows = db_rows(restored / "database" / DATABASE_NAME, "photos")
    kept = next((row for row in rows if row["id"] == ids[0]), None)
    if offset < 0:
        assert kept == next(row for row in before if row["id"] == ids[0])
    else:
        assert kept is None and len(list((restored / "originals").iterdir())) == 2
    assert len(load_manifest(snapshot)["photos"]) == 3


def test_expiry_during_long_restore_is_rechecked_before_opening_output(collection, outputs):
    app, _, settings, now, _, _, ids, _ = collection
    snapshot, restored = outputs
    due_photo(app, ids[0], now[0] + 100)
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    times = iter([now[0], now[0] + 100])
    result = restore_backup(snapshot, restored, clock=lambda: next(times))
    assert result["expired_excluded"] == 1
    assert len(list((restored / "originals").iterdir())) == 2
    assert not (restored / INCOMPLETE_MARKER).exists()


def test_unsaved_imports_are_closed_in_snapshot_only_and_not_copied(collection, outputs):
    app, client, settings, now, owner, album, _, _ = collection
    snapshot, restored = outputs
    for staged in (False, True):
        batch = start(client, album, picture_bytes()).json()["data"]
        if staged:
            upload(client, batch, picture_bytes())
        else:
            item, token = app.state.imports.begin_upload(
                batch["id"], batch["items"][0]["id"], owner
            )
            (settings.staging_dir / f"{item.storage_key}.{token}.part").write_bytes(b"synthetic")
    source_batches = db_rows(settings.database_path, "import_batches")
    source_items = db_rows(settings.database_path, "upload_items")
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    restore_backup(snapshot, restored, clock=lambda: now[0])
    assert db_rows(settings.database_path, "import_batches") == source_batches
    assert db_rows(settings.database_path, "upload_items") == source_items
    assert set(
        row["state"] for row in db_rows(restored / "database" / DATABASE_NAME, "import_batches")
    ) == {"committed", "canceled"}
    assert set(
        row["state"] for row in db_rows(restored / "database" / DATABASE_NAME, "upload_items")
    ) == {"committed", "discarded"}
    assert list((restored / "staging").iterdir()) == []
    assert len(list((restored / "originals").iterdir())) == 3


@pytest.mark.parametrize(
    "damage",
    [
        "photo",
        "missing",
        "database",
        "count",
        "traversal",
        "duplicate",
        "unknown",
        "wal",
        "version",
    ],
)
def test_corruption_or_unsafe_manifest_is_rejected_before_restore_creates_output(
    collection, outputs, damage
):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, restored = outputs
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    first = next((snapshot / "originals").iterdir())
    if damage == "photo":
        first.write_bytes(b"x" * first.stat().st_size)
    elif damage == "missing":
        first.unlink()
    elif damage == "database":
        database = snapshot / "database" / DATABASE_NAME
        with database.open("r+b") as stream:
            stream.write(b"synthetic corruption")
    elif damage == "count":
        update_manifest(snapshot, lambda v: v["counts"].update(users=99))
    elif damage == "traversal":
        update_manifest(snapshot, lambda v: v["photos"][0].update(storage_key="../outside"))
    elif damage == "duplicate":
        update_manifest(snapshot, lambda v: v["photos"].append(v["photos"][0]))
    elif damage == "unknown":
        (snapshot / "unknown.txt").write_bytes(b"not an archive member")
    elif damage == "wal":
        (snapshot / "database" / (DATABASE_NAME + "-wal")).write_bytes(b"not published")
    else:
        update_manifest(snapshot, lambda v: v.update(version=99))
    with pytest.raises((BackupError, ValueError)):
        verify_backup(snapshot)
    with pytest.raises((BackupError, ValueError)):
        restore_backup(snapshot, restored, clock=lambda: now[0])
    assert not restored.exists()


@pytest.mark.parametrize("damage", ["schema_version", "foreign_key", "trigger"])
def test_database_semantics_rejected_even_with_recomputed_hash(collection, outputs, damage):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, restored = outputs
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    with sqlite3.connect(snapshot / "database" / DATABASE_NAME) as db:
        if damage == "schema_version":
            db.execute("UPDATE alembic_version SET version_num='unsupported'")
        elif damage == "foreign_key":
            db.execute("UPDATE albums SET owner_id='missing-owner'")
        else:
            db.execute(
                "CREATE TRIGGER surprise AFTER DELETE ON sessions BEGIN DELETE FROM photos; END"
            )
    refresh_db_hash(snapshot)
    with pytest.raises(BackupError):
        restore_backup(snapshot, restored, clock=lambda: now[0])
    assert not restored.exists()


def test_missing_source_file_leaves_incomplete_backup_and_source_unchanged(collection, outputs):
    app, _, settings, now, _, _, ids, _ = collection
    snapshot, restored = outputs
    source_rows = db_rows(settings.database_path, "photos")
    original_for(app, settings, ids[0]).unlink()  # Synthetic missing disk copy.
    with pytest.raises(OSError):
        create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    assert (snapshot / INCOMPLETE_MARKER).exists()
    assert db_rows(settings.database_path, "photos") == source_rows
    with pytest.raises(BackupError):
        restore_backup(snapshot, restored, clock=lambda: now[0])
    with pytest.raises(RuntimeError, match="未完成"):
        with TestClient(create_app(settings_at(settings, snapshot))):
            pass
    assert not restored.exists()


@pytest.mark.parametrize("operation", ["create", "restore"])
def test_disk_failure_is_not_success_and_does_not_disclose_paths_or_exception(
    collection, outputs, monkeypatch, capsys, operation
):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, restored = outputs
    if operation == "restore":
        create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
        # CLI uses real time, keep this synthetic archive's declared time in the past.
        update_manifest(snapshot, lambda value: value.update(snapshot_at=1))
    original = backup._file_digest

    def fail(path, destination=None):
        if destination is not None:
            raise OSError("synthetic-private-secret-and-path")
        return original(path, destination)

    monkeypatch.setattr(backup, "_file_digest", fail)
    args = (
        ["create", "--data-dir", str(settings.data_dir), "--destination", str(snapshot)]
        if operation == "create"
        else ["restore", "--backup", str(snapshot), "--destination", str(restored)]
    )
    assert backup.main(args) == 1
    output = capsys.readouterr()
    assert output.out == "" and "MAINTENANCE_FAILED" in output.err
    assert "synthetic-private-secret-and-path" not in output.err
    assert str(settings.data_dir) not in output.err
    target = snapshot if operation == "create" else restored
    assert (target / INCOMPLETE_MARKER).exists()
    with pytest.raises(RuntimeError, match="未完成"):
        with TestClient(create_app(settings_at(settings, target))):
            pass
    with InstanceLock(settings.data_dir):
        pass  # Failure has released the source lock.


@pytest.mark.parametrize(
    "target_kind", ["existing", "inside", "ancestor", "repo", "missing_parent"]
)
def test_output_path_protection_never_overwrites(collection, outputs, target_kind):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, _ = outputs
    if target_kind == "existing":
        snapshot.mkdir()
        sentinel = snapshot / "keep.txt"
        sentinel.write_bytes(b"keep")
    elif target_kind == "inside":
        snapshot = settings.data_dir / "backup.cmbackup"
    elif target_kind == "ancestor":
        snapshot = settings.data_dir.parent
    elif target_kind == "repo":
        repo = outputs[0].parent / "synthetic-checkout"
        repo.mkdir()
        (repo / ".git").mkdir()
        snapshot = repo / "private.cmbackup"
    else:
        snapshot = outputs[0].parent / "missing-parent" / "backup.cmbackup"
    with pytest.raises((BackupError, OSError)):
        create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    if target_kind == "existing":
        assert sentinel.read_bytes() == b"keep"


def test_hardlinked_original_refused_without_modifying_source(collection, outputs):
    app, _, settings, now, _, _, ids, _ = collection
    snapshot, _ = outputs
    source = original_for(app, settings, ids[0])
    alias = outputs[0].parent / "synthetic-hardlink.png"
    os.link(source, alias)
    before = source.read_bytes()
    with pytest.raises(BackupError, match="独立"):
        create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    assert source.read_bytes() == alias.read_bytes() == before


def test_clock_rollback_and_existing_restore_target_are_rejected(collection, outputs):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, restored = outputs
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    with pytest.raises(BackupError, match="系统时间"):
        restore_backup(snapshot, restored, clock=lambda: now[0] - 1)
    assert not restored.exists()
    restored.mkdir()
    (restored / "keep.txt").write_bytes(b"existing data")
    with pytest.raises(BackupError, match="新目录"):
        restore_backup(snapshot, restored, clock=lambda: now[0])
    assert (restored / "keep.txt").read_bytes() == b"existing data"


def test_instance_guard_blocks_service_migration_and_backup_during_maintenance(
    collection, outputs, monkeypatch
):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, _ = outputs
    monkeypatch.setattr("city_memories.main.InstanceLock", InstanceLock)
    with InstanceLock(settings.data_dir):
        with pytest.raises(BackupError, match="停止后端"):
            create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
        with pytest.raises(RuntimeError, match="只能运行一个"):
            with TestClient(create_app(settings)):
                pass
        with pytest.raises(RuntimeError, match="只能运行一个"):
            command.upgrade(Config(Path(__file__).resolve().parents[1] / "alembic.ini"), "head")
    assert not snapshot.exists()


def test_copy_holds_lock_and_releases_it_after_completion(collection, outputs, monkeypatch):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, _ = outputs
    ready, resume = threading.Event(), threading.Event()
    original = backup._file_digest

    def pause(path, destination=None):
        if destination is not None:
            ready.set()
            assert resume.wait(5)
        return original(path, destination)

    monkeypatch.setattr(backup, "_file_digest", pause)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(create_backup, settings.data_dir, snapshot, clock=lambda: now[0])
        try:
            assert ready.wait(5)
            with pytest.raises(RuntimeError, match="只能运行一个"):
                with InstanceLock(settings.data_dir):
                    pass
        finally:
            resume.set()
        assert future.result(timeout=5)["active_photos"] == 3
    with InstanceLock(settings.data_dir):
        pass


def cli(*args, env=None):
    return subprocess.run(
        [sys.executable, "-m", "city_memories.backup", *map(str, args)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=os.environ | {"PYTHONIOENCODING": "utf-8"} | (env or {}),
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )


def test_real_cli_rejects_running_server_then_creates_verifies_restores_and_restarts(
    collection, outputs
):
    _, _, settings, _, _, _, ids, contents = collection
    snapshot, restored = outputs
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = os.environ | {
        "CITY_MEMORIES_DATA_DIR": str(settings.data_dir),
        "CITY_MEMORIES_CLEANUP_ENABLED": "false",
        "CITY_MEMORIES_ALLOWED_ORIGINS": f'["http://127.0.0.1:{port}"]',
    }
    with running_server(port, env):
        blocked = cli("create", "--data-dir", settings.data_dir, "--destination", snapshot)
        assert blocked.returncode == 1 and "MAINTENANCE_BUSY" in blocked.stderr
        assert not snapshot.exists()
    for args in (
        ("create", "--data-dir", settings.data_dir, "--destination", snapshot),
        ("verify", "--backup", snapshot),
        ("restore", "--backup", snapshot, "--destination", restored),
    ):
        result = cli(*args)
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["active_photos"] == 3
        assert str(settings.data_dir) not in result.stdout
    with running_server(port, env | {"CITY_MEMORIES_DATA_DIR": str(restored)}):
        assert len(db_rows(restored / "database" / DATABASE_NAME, "photos")) == 3
    rows = db_rows(restored / "database" / DATABASE_NAME, "photos")
    for photo_id, content in zip(ids, contents, strict=True):
        row = next(row for row in rows if row["id"] == photo_id)
        assert (restored / "originals" / row["storage_key"]).read_bytes() == content


def test_completed_archive_cannot_be_started_or_migrated_as_live_data(
    collection, outputs, monkeypatch
):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, _ = outputs
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    with pytest.raises(RuntimeError, match="备份目录"):
        with TestClient(create_app(settings_at(settings, snapshot))):
            pass
    monkeypatch.setenv("CITY_MEMORIES_DATA_DIR", str(snapshot))
    from city_memories.config import get_settings

    get_settings.cache_clear()
    try:
        with pytest.raises(RuntimeError, match="备份目录"):
            command.upgrade(Config(Path(__file__).resolve().parents[1] / "alembic.ini"), "head")
    finally:
        get_settings.cache_clear()
    assert verify_backup(snapshot)["active_photos"] == 3


@pytest.mark.parametrize("damage", ["missing_version", "boolean_version", "duplicate_json_key"])
def test_manifest_requires_explicit_unambiguous_version(collection, outputs, damage):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, _ = outputs
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    if damage == "missing_version":
        update_manifest(snapshot, lambda value: value.pop("version"))
    elif damage == "boolean_version":
        update_manifest(snapshot, lambda value: value.update(version=True))
    else:
        path = snapshot / BACKUP_MANIFEST
        path.write_text(
            path.read_text(encoding="utf-8").replace('"version": 1', '"version": 1, "version": 1'),
            encoding="utf-8",
        )
    with pytest.raises((BackupError, ValueError)):
        verify_backup(snapshot)


def test_committed_wal_pages_are_included_in_consistent_snapshot(collection, outputs):
    _, _, settings, now, _, _, ids, _ = collection
    snapshot, restored = outputs
    with sqlite3.connect(settings.database_path, isolation_level=None) as db:
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        db.execute("UPDATE photos SET note=? WHERE id=?", ("只在 WAL 中的已提交文字", ids[0]))
        wal = settings.database_path.with_name(DATABASE_NAME + "-wal")
        assert wal.stat().st_size > 0
        create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    restore_backup(snapshot, restored, clock=lambda: now[0])
    rows = db_rows(restored / "database" / DATABASE_NAME, "photos")
    assert next(row for row in rows if row["id"] == ids[0])["note"] == "只在 WAL 中的已提交文字"


def test_final_validation_failure_keeps_backup_incomplete(collection, outputs, monkeypatch):
    _, _, settings, now, _, _, _, _ = collection
    snapshot, _ = outputs

    def fail(*args, **kwargs):
        raise BackupError("SYNTHETIC", "测试校验失败")

    with monkeypatch.context() as patch:
        patch.setattr(backup, "_verify_locked", fail)
        with pytest.raises(BackupError):
            create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    assert (snapshot / BACKUP_MANIFEST).exists()
    assert (snapshot / INCOMPLETE_MARKER).exists()
    with pytest.raises(BackupError, match="未完成"):
        verify_backup(snapshot)


def test_corrupt_source_original_does_not_create_successful_backup(collection, outputs):
    app, _, settings, now, _, _, ids, _ = collection
    snapshot, _ = outputs
    path = original_for(app, settings, ids[0])
    corrupt = b"x" * path.stat().st_size
    path.write_bytes(corrupt)
    with pytest.raises(BackupError, match="内容不符"):
        create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    assert path.read_bytes() == corrupt
    assert (snapshot / INCOMPLETE_MARKER).exists()


def test_empty_database_can_be_backed_up_and_restored(environment, outputs):
    _, _, settings, now = environment
    snapshot, restored = outputs
    assert create_backup(settings.data_dir, snapshot, clock=lambda: now[0]) == {
        "users": 0,
        "albums": 0,
        "active_photos": 0,
        "trashed_photos": 0,
        "original_bytes": 0,
    }
    assert restore_backup(snapshot, restored, clock=lambda: now[0])["users"] == 0
    with TestClient(create_app(settings_at(settings, restored))) as recovered:
        signed_in(recovered, "Restored_First_User")


def test_junction_backup_root_is_refused_and_source_is_untouched(collection, outputs):
    _, _, settings, now, _, _, _, _ = collection
    if os.name != "nt":
        pytest.skip("Windows junction")
    snapshot, restored = outputs
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])
    linked = snapshot.parent / "synthetic-linked-backup"
    subprocess.run(
        ["cmd.exe", "/d", "/c", "mklink", "/J", str(linked), str(snapshot)],
        check=True,
        capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        with pytest.raises(BackupError, match="链接"):
            restore_backup(linked, restored, clock=lambda: now[0])
        assert not restored.exists()
        assert verify_backup(snapshot)["active_photos"] == 3
    finally:
        linked.rmdir()  # Only this fixture's junction; never a recursive delete.


def test_expired_copy_delete_failure_keeps_restore_closed_and_backup_intact(
    collection, outputs, monkeypatch
):
    app, _, settings, now, _, _, ids, _ = collection
    snapshot, restored = outputs
    due_photo(app, ids[0], now[0] + 1)
    create_backup(settings.data_dir, snapshot, clock=lambda: now[0])

    def fail(*args):
        raise PermissionError("synthetic private-copy deletion failure")

    with monkeypatch.context() as patch:
        patch.setattr(backup.ManagedDirectory, "unlink", fail)
        times = iter([now[0], now[0] + 1])
        with pytest.raises(PermissionError):
            restore_backup(snapshot, restored, clock=lambda: next(times))
    assert (restored / INCOMPLETE_MARKER).exists()
    assert verify_backup(snapshot)["trashed_photos"] == 1
    with pytest.raises(RuntimeError, match="未完成"):
        with TestClient(create_app(settings_at(settings, restored))):
            pass
