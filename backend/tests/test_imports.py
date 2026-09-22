import hashlib
import io
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import event, func, select, update
from sqlalchemy.exc import OperationalError
from test_albums import create, signed_in
from test_auth import csrf
from test_auth import environment as environment

from city_memories import storage
from city_memories.imports import LEASE
from city_memories.main import create_app
from city_memories.models import Album, Photo


def picture_bytes(format="PNG", animated=False):
    output = io.BytesIO()
    image = Image.new("RGB", (32, 24), (31, 124, 186))
    options = (
        {"save_all": True, "append_images": [Image.new("RGB", image.size, "red")], "duration": 100}
        if animated
        else {}
    )
    if format == "JPEG":
        options["exif"] = b"Exif\x00\x00MM\x00*\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00"
    image.save(output, format=format, **options)
    return output.getvalue()


def metadata(content, name="synthetic.png"):
    return {
        "original_filename": name,
        "byte_size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }


def start(client, album_id, content, key=None, name="synthetic.png"):
    return client.post(
        f"/api/v1/albums/{album_id}/imports",
        headers={**csrf(client), "Idempotency-Key": key or str(uuid4())},
        json={"items": [metadata(content, name)]},
    )


def upload(client, batch, content, item_index=0, **kwargs):
    return client.put(
        f"/api/v1/imports/{batch['id']}/items/{batch['items'][item_index]['id']}/content",
        headers=csrf(client),
        files={"file": ("untrusted.any", content, "application/octet-stream")},
        **kwargs,
    )


def commit(client, batch, revision=None, partial=False):
    return client.post(
        f"/api/v1/imports/{batch['id']}/commit",
        headers=csrf(client),
        json={
            "expected_album_revision": revision or batch["album_revision"],
            "allow_partial": partial,
        },
    )


@pytest.fixture
def album_environment(environment):
    app, client, settings, now = environment
    signed_in(client)
    album = create(client, 2026).json()["data"]
    return app, client, settings, now, album


@pytest.mark.parametrize("format", ["JPEG", "PNG", "WEBP"])
def test_original_bytes_persist_only_after_commit_and_survive_restart(
    album_environment, tmp_path, format
):
    app, client, settings, now, album = album_environment
    content = picture_bytes(format)
    source = tmp_path / f"source.{format.lower()}"
    source.write_bytes(content)  # Synthetic fixture only, never a user's original.
    batch = start(client, album["id"], content, name=source.name).json()["data"]
    assert batch["state"] == "open"
    assert upload(client, batch, content).json()["data"]["state"] == "staged"
    assert client.get(f"/api/v1/albums/{album['id']}").json()["data"]["photo_count"] == 0
    assert client.get("/api/v1/me/atlas").json()["data"]["items"][0]["lit"] is False
    receipt = commit(client, batch)
    assert receipt.status_code == 200
    result = receipt.json()["data"]
    assert result["album_revision"] == 2 and len(result["photo_ids"]) == 1
    photo_id = result["photo_ids"][0]
    assert source.read_bytes() == content
    source.rename(tmp_path / "moved-synthetic-source")
    raw = client.get(f"/api/v1/photos/{photo_id}/original")
    assert raw.status_code == 200 and raw.content == content
    assert (
        raw.headers["content-type"]
        == {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}[format]
    )
    assert (
        raw.headers["cache-control"] == "private, no-store"
        and raw.headers["x-content-type-options"] == "nosniff"
    )
    assert client.get("/api/v1/me/atlas").json()["data"]["photo_count"] == 1
    assert client.get("/api/v1/me/atlas").json()["data"]["items"][0]["lit"] is True
    assert list(settings.staging_dir.iterdir()) == []
    assert len(list(settings.originals_dir.iterdir())) == 1
    # An application restart reads the independently stored bytes, not the source.
    with TestClient(create_app(settings)) as restarted:
        restarted.app.state.auth.clock = lambda: now[0]
        restarted.cookies.update(client.cookies)
        assert restarted.get(f"/api/v1/photos/{photo_id}/original").content == content
        assert commit(restarted, batch).json()["data"] == result


def test_idempotency_duplicate_bytes_and_concurrent_commit(album_environment):
    app, client, _, _, album = album_environment
    content = picture_bytes()
    key = str(uuid4())
    batch = start(client, album["id"], content, key).json()["data"]
    replay = start(client, album["id"], content, key)
    assert replay.status_code == 200 and replay.json()["data"]["id"] == batch["id"]
    assert start(client, album["id"], picture_bytes("JPEG"), key).status_code == 409
    assert upload(client, batch, content).status_code == 200
    assert upload(client, batch, content).status_code == 200
    headers = csrf(client)

    def attempt(_):
        return client.post(
            f"/api/v1/imports/{batch['id']}/commit",
            headers=headers,
            json={"expected_album_revision": 1},
        )

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(attempt, range(4)))
    assert all(result.status_code == 200 for result in results)
    assert all(result.json() == results[0].json() for result in results)
    assert commit(client, batch, revision=2).status_code == 409
    assert client.delete(f"/api/v1/imports/{batch['id']}", headers=csrf(client)).status_code == 409
    second = start(client, album["id"], content).json()["data"]
    upload(client, second, content)
    second_result = commit(client, second).json()["data"]
    assert second_result["photo_ids"] != results[0].json()["data"]["photo_ids"]
    with app.state.auth.sessions() as db:
        photos = db.scalars(select(Photo).order_by(Photo.position)).all()
        assert [photo.position for photo in photos] == [0, 1]
        assert photos[0].sha256 == photos[1].sha256
        assert photos[0].storage_key != photos[1].storage_key


@pytest.mark.parametrize(
    "content",
    [
        b"<svg/onload=alert(1)>",
        b"not an image",
        picture_bytes("BMP"),
        picture_bytes("WEBP", True),
        picture_bytes("PNG", True),
        picture_bytes("PNG")[:40],
    ],
)
def test_unsupported_animated_or_corrupt_images_never_become_visible(album_environment, content):
    app, client, settings, _, album = album_environment
    batch = start(client, album["id"], content).json()["data"]
    assert upload(client, batch, content).status_code == 415
    status = client.get(f"/api/v1/imports/{batch['id']}").json()["data"]
    assert status["items"][0]["state"] == "failed"
    assert commit(client, batch).status_code == 409
    with app.state.auth.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Photo)) == 0
    assert (
        list(settings.staging_dir.iterdir()) == [] and list(settings.originals_dir.iterdir()) == []
    )


def test_hash_size_pixel_limits_and_same_item_retry(album_environment, monkeypatch):
    _, client, settings, _, album = album_environment
    content = picture_bytes()
    batch = start(client, album["id"], content).json()["data"]
    assert upload(client, batch, content[:-1] + b"x").status_code == 422
    assert upload(client, batch, content[:-1]).status_code == 422
    assert upload(client, batch, content + b"x").status_code == 413
    monkeypatch.setattr(storage, "MAX_PIXELS", 100)
    assert upload(client, batch, content).status_code == 413
    monkeypatch.setattr(storage, "MAX_PIXELS", 80_000_000)
    assert upload(client, batch, content).status_code == 200
    assert commit(client, batch).status_code == 200
    assert list(settings.staging_dir.iterdir()) == []


def test_multipart_bounded_before_parsing_and_private_checks_before_body(album_environment):
    _, client, _, _, album = album_environment
    batch = start(client, album["id"], picture_bytes()).json()["data"]
    path = f"/api/v1/imports/{batch['id']}/items/{batch['items'][0]['id']}/content"
    headers = csrf(client)
    oversized = (
        b'--x\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\n' + b"x" * 70000
    )
    response = client.put(
        path,
        headers={
            **headers,
            "Content-Type": "multipart/form-data; boundary=x",
            "Content-Length": "1",
        },
        content=iter([oversized[:30000], oversized[30000:]]),
    )
    assert response.status_code == 413
    assert (
        client.put(
            path, headers=headers, files=[("file", ("a", b"1")), ("file", ("b", b"2"))]
        ).status_code
        == 422
    )
    assert (
        client.put(
            path, headers=headers, data={"text": "bad"}, files={"file": ("a", b"1")}
        ).status_code
        == 422
    )
    assert client.put(path, headers=headers, content=b"raw").status_code == 415
    assert (
        client.put(
            path,
            headers={**headers, "Content-Type": "multipart/form-data; boundary=x"},
            content=b"broken",
        ).status_code
        == 422
    )
    consumed = []

    def body():
        consumed.append(True)
        yield b"private body must not be read"

    assert (
        client.put(
            "/api/v1/imports/missing/items/missing/content", headers=headers, content=body()
        ).status_code
        == 404
    )
    assert consumed == []
    assert client.put(path, content=body()).status_code == 403
    assert consumed == []


def test_cancel_expiry_leases_and_no_stale_publishing(album_environment):
    app, client, settings, now, album = album_environment
    content = picture_bytes()
    service = app.state.imports
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    batch = start(client, album["id"], content).json()["data"]
    item, old_token = service.begin_upload(batch["id"], batch["items"][0]["id"], owner)
    assert upload(client, batch, content).status_code == 409
    now[0] += LEASE
    newer_item, new_token = service.begin_upload(batch["id"], item.id, owner)
    with pytest.raises(Exception) as failure:
        service.receive(batch["id"], item, owner, old_token, io.BytesIO(content))
    assert failure.value.code == "UPLOAD_ATTEMPT_EXPIRED"
    assert (
        service.receive(batch["id"], newer_item, owner, new_token, io.BytesIO(content))["state"]
        == "staged"
    )
    assert client.delete(f"/api/v1/imports/{batch['id']}", headers=csrf(client)).status_code == 204
    assert client.delete(f"/api/v1/imports/{batch['id']}", headers=csrf(client)).status_code == 204
    assert upload(client, batch, content).status_code == 409
    assert commit(client, batch).status_code == 409
    assert (
        list(settings.staging_dir.iterdir()) == [] and list(settings.originals_dir.iterdir()) == []
    )
    second = start(client, album["id"], content).json()["data"]
    now[0] += 24 * 3600 * 1000
    assert client.get(f"/api/v1/imports/{second['id']}").status_code == 410
    assert upload(client, second, content).status_code == 410
    assert commit(client, second).status_code == 410


def test_large_multipart_headers_and_global_slots_are_bounded(album_environment):
    app, client, _, _, album = album_environment
    content = picture_bytes()
    batch = start(client, album["id"], content).json()["data"]
    path = f"/api/v1/imports/{batch['id']}/items/{batch['items'][0]['id']}/content"
    header_attack = (
        b'--x\r\nContent-Disposition: form-data; name="file"; filename="x"\r\nX-Long: '
        + b"a" * (17 * 1024)
        + b"\r\n\r\n"
        + content
        + b"\r\n--x--\r\n"
    )
    assert (
        client.put(
            path,
            headers={**csrf(client), "Content-Type": "multipart/form-data; boundary=x"},
            content=header_attack,
        ).status_code
        == 422
    )
    slots = app.state.imports.slots
    assert slots.acquire(blocking=False) and slots.acquire(blocking=False)
    try:
        busy = upload(client, batch, content)
        assert busy.status_code == 429 and busy.headers["retry-after"] == "2"
    finally:
        slots.release()
        slots.release()
    assert upload(client, batch, content).status_code == 200


def test_actual_fifty_mib_boundary_preserves_bytes(album_environment):
    _, client, _, _, album = album_environment
    # A tiny valid PNG padded to 50 MiB tests byte limits, not large-image performance.
    content = picture_bytes().ljust(storage.MAX_FILE_BYTES, b"\0")
    batch = start(client, album["id"], content).json()["data"]
    assert upload(client, batch, content + b"x").status_code == 413
    assert upload(client, batch, content).status_code == 200
    photo_id = commit(client, batch).json()["data"]["photo_ids"][0]
    result = client.get(f"/api/v1/photos/{photo_id}/original")
    assert result.status_code == 200
    assert len(result.content) == storage.MAX_FILE_BYTES
    assert hashlib.sha256(result.content).digest() == hashlib.sha256(content).digest()


def test_failure_after_photo_insert_rolls_back_all_metadata(album_environment):
    app, client, settings, _, album = album_environment
    content = picture_bytes()
    batch = start(client, album["id"], content).json()["data"]
    assert upload(client, batch, content).status_code == 200
    inserted = []

    def fail_after_insert(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.startswith("INSERT INTO photos"):
            inserted.append(True)
            raise OperationalError("hidden SQL", {}, Exception("hidden disk failure"))

    event.listen(app.state.engine, "after_cursor_execute", fail_after_insert)
    try:
        failed = commit(client, batch)
        assert failed.status_code == 503 and "hidden" not in failed.text
    finally:
        event.remove(app.state.engine, "after_cursor_execute", fail_after_insert)
    assert inserted == [True]
    current = client.get(f"/api/v1/albums/{album['id']}").json()["data"]
    assert current["photo_count"] == 0 and current["revision"] == 1
    status = client.get(f"/api/v1/imports/{batch['id']}").json()["data"]
    assert status["state"] == "open" and status["items"][0]["state"] == "staged"
    assert len(list(settings.originals_dir.iterdir())) == 1
    assert commit(client, batch).status_code == 200
    assert commit(client, batch).status_code == 200
    assert client.get(f"/api/v1/albums/{album['id']}").json()["data"]["photo_count"] == 1


def test_two_accounts_cannot_read_or_modify_uploads_and_originals(album_environment):
    app, client, _, _, album = album_environment
    content = picture_bytes()
    batch = start(client, album["id"], content).json()["data"]
    upload(client, batch, content)
    photo = commit(client, batch).json()["data"]["photo_ids"][0]
    with TestClient(app) as other:
        signed_in(other, "Import_Other")
        assert start(other, album["id"], content).status_code == 404
        assert other.get(f"/api/v1/imports/{batch['id']}").status_code == 404
        assert upload(other, batch, content).status_code == 404
        assert commit(other, batch).status_code == 404
        assert (
            other.delete(f"/api/v1/imports/{batch['id']}", headers=csrf(other)).status_code == 404
        )
        assert other.get(f"/api/v1/photos/{photo}/original").status_code == 404
    cookie = client.cookies.get("city_memories_session")
    client.post("/api/v1/auth/logout", headers=csrf(client))
    client.cookies.set("city_memories_session", cookie)
    assert client.get(f"/api/v1/photos/{photo}/original").status_code == 401


def test_commit_version_conflict_and_missing_file_never_report_success(album_environment):
    app, client, settings, _, album = album_environment
    content = picture_bytes()
    batch = start(client, album["id"], content).json()["data"]
    upload(client, batch, content)
    with app.state.auth.sessions.begin() as db:
        db.execute(update(Album).where(Album.id == album["id"]).values(revision=2))
    assert commit(client, batch).status_code == 409
    staged = next(settings.staging_dir.iterdir())
    staged.rename(settings.staging_dir / "test-file-moved-away")
    assert commit(client, batch, revision=2).status_code == 503
    assert client.get(f"/api/v1/albums/{album['id']}").json()["data"]["photo_count"] == 0


def test_disk_and_database_failure_can_retry_without_duplicate_photo(
    album_environment, monkeypatch
):
    app, client, settings, _, album = album_environment
    content = picture_bytes()
    batch = start(client, album["id"], content).json()["data"]
    import city_memories.imports as module

    actual_replace = module.os.replace

    def disk_full(*_):
        raise OSError("private disk location")

    monkeypatch.setattr(module.os, "replace", disk_full)
    assert upload(client, batch, content).status_code == 503
    monkeypatch.setattr(module.os, "replace", actual_replace)
    assert upload(client, batch, content).status_code == 200
    begin = app.state.imports.sessions.begin

    def broken_transaction():
        raise OperationalError("private SQL", {}, Exception("private data"))

    headers = csrf(client)
    monkeypatch.setattr(app.state.imports.sessions, "begin", broken_transaction)
    failed = client.post(
        f"/api/v1/imports/{batch['id']}/commit",
        headers=headers,
        json={"expected_album_revision": 1},
    )
    assert failed.status_code == 503 and "private" not in failed.text
    assert len(list(settings.originals_dir.iterdir())) == 1  # File published, no visible DB row.
    assert client.get(f"/api/v1/albums/{album['id']}").json()["data"]["photo_count"] == 0
    monkeypatch.setattr(app.state.imports.sessions, "begin", begin)
    assert commit(client, batch).status_code == 200
    assert commit(client, batch).status_code == 200
    assert client.get(f"/api/v1/albums/{album['id']}").json()["data"]["photo_count"] == 1


def test_contract_order_partial_opt_in_and_saved_receipt_survives_photo_removal(album_environment):
    app, client, _, _, album = album_environment
    content = picture_bytes()
    response = client.post(
        f"/api/v1/albums/{album['id']}/imports",
        headers={**csrf(client), "Idempotency-Key": str(uuid4())},
        json={
            "items": [metadata(content, name) for name in ("first.png", "second.png", "last.png")]
        },
    )
    batch = response.json()["data"]
    upload(client, batch, content, 1)
    upload(client, batch, content, 0)
    assert commit(client, batch).status_code == 409
    result = commit(client, batch, partial=True).json()["data"]
    assert result["failed_item_ids"] == [batch["items"][2]["id"]]
    with app.state.auth.sessions() as db:
        photos = db.scalars(select(Photo).order_by(Photo.position)).all()
        assert [photo.original_filename for photo in photos] == ["first.png", "second.png"]
    with app.state.auth.sessions.begin() as db:
        for photo in db.scalars(select(Photo)).all():
            db.delete(photo)  # Synthetic fixture emulates later permanent deletion.
    assert commit(client, batch, partial=True).json()["data"] == result
    with app.state.auth.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Photo)) == 0


@pytest.mark.parametrize(
    "override",
    [
        {"original_filename": "../escape.png"},
        {"original_filename": "C:\\private.png"},
        {"byte_size": 0},
        {"byte_size": 50 * 1024 * 1024 + 1},
        {"byte_size": True},
        {"sha256": "wrong"},
        {"owner_id": "forged"},
    ],
)
def test_invalid_import_metadata_rejected(album_environment, override):
    _, client, _, _, album = album_environment
    result = client.post(
        f"/api/v1/albums/{album['id']}/imports",
        headers={**csrf(client), "Idempotency-Key": str(uuid4())},
        json={"items": [{**metadata(picture_bytes()), **override}]},
    )
    assert result.status_code == 422


def test_interrupted_upload_is_retryable_on_restart(album_environment):
    app, client, settings, now, album = album_environment
    content = picture_bytes()
    batch = start(client, album["id"], content).json()["data"]
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    app.state.imports.begin_upload(batch["id"], batch["items"][0]["id"], owner)
    with TestClient(create_app(settings)) as restarted:
        restarted.app.state.auth.clock = lambda: now[0]
        restarted.cookies.update(client.cookies)
        status = restarted.get(f"/api/v1/imports/{batch['id']}").json()["data"]
        assert status["items"][0]["state"] == "failed"
        assert upload(restarted, batch, content).status_code == 200
        assert commit(restarted, batch).status_code == 200
