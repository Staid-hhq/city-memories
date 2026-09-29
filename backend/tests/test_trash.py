"""T09 uses temporary databases and synthetic originals only."""

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from photo_fixtures import seed_copies, seed_photos
from sqlalchemy import event
from sqlalchemy.exc import OperationalError
from test_albums import create, signed_in
from test_auth import csrf, login
from test_auth import environment as environment

from city_memories.main import create_app
from city_memories.models import Photo, UploadItem
from city_memories.storage import private_path
from city_memories.trash import RETENTION_MS


@pytest.fixture
def collection(environment):
    app, client, settings, now = environment
    signed_in(client)
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    album = create(client, 2026).json()["data"]["id"]
    ids, contents = seed_photos(app, owner, album, 3)
    return app, client, settings, now, owner, album, ids, contents


def read(client, path):
    response = client.get("/api/v1" + path)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def change(client, photo, restore=False, **versions):
    path = f"/trash/photos/{photo}" if restore else f"/photos/{photo}"
    if not versions:
        current = read(client, path)
        versions = {
            "expected_photo_revision": current["revision"],
            "expected_album_revision": current["album_revision"],
        }
    return client.post(
        "/api/v1" + path + ("/restore" if restore else "/trash"),
        headers=csrf(client),
        json=versions,
    )


def test_delete_hides_normal_views_preserves_copy_note_file_and_import_receipt(collection):
    app, client, _, now, owner, album, ids, contents = collection
    copies = seed_copies(app, owner, album, [contents[0]], ["different-name.png"])
    assert (
        client.patch(
            f"/api/v1/photos/{ids[0]}/note",
            headers=csrf(client),
            json={"note": "被保留的文字 🌅", "expected_photo_revision": 1},
        ).status_code
        == 200
    )
    with app.state.auth.sessions() as db:
        photo = db.get(Photo, ids[0])
        storage, upload = photo.storage_key, photo.upload_item_id
        batch_id = db.get(UploadItem, upload).batch_id
    response = change(client, ids[0])
    assert response.status_code == 200
    result = response.json()["data"]
    assert result["deleted_at"] == now[0] and result["purge_after"] == now[0] + RETENTION_MS
    assert result["remaining_ms"] == RETENTION_MS and result["note"] == "被保留的文字 🌅"
    assert result["revision"] == 3 and result["album_revision"] == 4
    assert response.headers["cache-control"] == "private, no-store"
    assert not any(key in response.text for key in ("sha256", "storage_key", "owner_id"))
    assert client.get(f"/api/v1/photos/{ids[0]}").status_code == 404
    assert client.get(f"/api/v1/photos/{ids[0]}/original").status_code == 404
    assert client.get(result["original_url"]).content == contents[0]
    assert read(client, f"/albums/{album}")["cover_photo_id"] == ids[1]
    assert read(client, f"/albums/{album}")["photo_count"] == 3
    assert read(client, f"/albums/{album}/duplicates")["items"] == []
    assert read(client, f"/photos/{copies[0]}")["note"] == ""
    page = read(client, "/trash/photos")
    assert page["photo_count"] == 1 and "note" not in page["items"][0]
    assert page["items"][0]["year"] == 2026 and page["items"][0]["city"]["name"] == "深圳市"
    replay = client.post(
        f"/api/v1/imports/{batch_id}/commit",
        headers=csrf(client),
        json={"expected_album_revision": 1},
    )
    assert replay.status_code == 200 and replay.json()["data"]["photo_ids"] == ids
    with app.state.auth.sessions() as db:
        after = db.get(Photo, ids[0])
        assert after.state == "trashed" and after.position is None
        assert (after.storage_key, after.upload_item_id) == (storage, upload)
    assert client.get(f"/api/v1/photos/{copies[0]}/original").content == contents[0]


def test_restore_appends_preserves_bytes_note_and_duplicate_membership(collection):
    app, client, _, now, owner, album, ids, contents = collection
    copies = seed_copies(app, owner, album, [contents[0]], ["same.png"])
    assert change(client, ids[0]).status_code == 200
    now[0] += 1234
    restored = change(client, ids[0], restore=True)
    assert restored.status_code == 200 and restored.json()["data"]["duplicate_count"] == 2
    detail = read(client, f"/photos/{ids[0]}")
    assert detail["ordinal"] == 4 and detail["previous_photo_id"] == copies[0]
    assert detail["revision"] == 3 and detail["album_revision"] == 5
    assert client.get(detail["original_url"]).content == contents[0]
    assert read(client, "/trash/photos")["items"] == []
    assert client.get(f"/api/v1/trash/photos/{ids[0]}/original").status_code == 409
    with app.state.auth.sessions() as db:
        photo = db.get(Photo, ids[0])
        assert photo.deleted_at is None and photo.purge_after is None and photo.state == "active"
    again = change(client, ids[0]).json()["data"]
    assert again["deleted_at"] == now[0] and again["purge_after"] == now[0] + RETENTION_MS


def test_last_photo_keeps_empty_album_and_city_and_restores_unmarked(collection):
    app, client, _, _, owner, _, original_ids, _ = collection
    album = create(client, None).json()["data"]["id"]
    ids, _ = seed_photos(app, owner, album, 1)
    change(client, ids[0])
    empty = read(client, f"/albums/{album}")
    assert empty["year"] is None and empty["photo_count"] == 0 and empty["cover_photo_id"] is None
    for photo_id in original_ids:
        assert change(client, photo_id).status_code == 200
    atlas = read(client, "/me/atlas")
    assert atlas["album_count"] == 2 and atlas["photo_count"] == 0
    assert all(not city["lit"] for city in atlas["items"])
    assert read(client, f"/trash/photos/{ids[0]}")["year"] is None
    assert change(client, ids[0], restore=True).status_code == 200
    assert read(client, f"/photos/{ids[0]}")["ordinal"] == 1
    assert read(client, "/me/atlas")["photo_count"] == 1
    assert read(client, "/me/atlas")["items"][0]["lit"]


@pytest.mark.parametrize("offset,allowed", [(-1, True), (0, False), (1, False)])
def test_exact_retention_boundary_for_list_detail_original_restore(collection, offset, allowed):
    _, client, _, now, _, _, ids, _ = collection
    deleted = change(client, ids[0]).json()["data"]
    now[0] = deleted["purge_after"] + offset
    client.cookies.clear()
    assert login(client, "Album_Traveler").status_code == 200
    assert read(client, "/trash/photos")["photo_count"] == int(allowed)
    for suffix in ("", "/original"):
        result = client.get(f"/api/v1/trash/photos/{ids[0]}{suffix}")
        assert result.status_code == (200 if allowed else 410)
    result = change(
        client, ids[0], restore=True, expected_photo_revision=2, expected_album_revision=3
    )
    assert result.status_code == (200 if allowed else 410)


def test_purging_never_reads_or_restores_and_original_is_not_deleted(collection):
    app, client, settings, _, _, _, ids, contents = collection
    change(client, ids[0])
    with app.state.auth.sessions.begin() as db:
        photo = db.get(Photo, ids[0])
        photo.state = "purging"
        path = private_path(settings.originals_dir, photo.storage_key)
    assert path.read_bytes() == contents[0]
    assert read(client, "/trash/photos")["items"] == []
    assert client.get(f"/api/v1/trash/photos/{ids[0]}").status_code == 410
    assert client.get(f"/api/v1/trash/photos/{ids[0]}/original").status_code == 410
    assert (
        change(
            client, ids[0], restore=True, expected_photo_revision=2, expected_album_revision=3
        ).status_code
        == 410
    )


def test_photo_and_album_conflicts_require_fresh_explicit_confirmation(collection):
    _, client, _, _, _, album, ids, _ = collection
    old = {"expected_photo_revision": 1, "expected_album_revision": 2}
    assert (
        client.patch(
            f"/api/v1/photos/{ids[0]}/note",
            headers=csrf(client),
            json={"note": "另一窗口", "expected_photo_revision": 1},
        ).status_code
        == 200
    )
    assert change(client, ids[0], **old).json()["error"]["code"] == "PHOTO_CHANGED"
    assert change(client, ids[0]).status_code == 200
    deleted = read(client, f"/trash/photos/{ids[0]}")
    change(client, ids[1])
    assert (
        change(
            client,
            ids[0],
            restore=True,
            expected_photo_revision=deleted["revision"],
            expected_album_revision=deleted["album_revision"],
        ).json()["error"]["code"]
        == "ALBUM_CHANGED"
    )
    assert change(client, ids[0], restore=True).status_code == 200
    assert read(client, f"/photos/{ids[0]}")["note"] == "另一窗口"
    assert read(client, f"/albums/{album}")["photo_count"] == 2
    assert change(client, ids[0], restore=True, **old).status_code == 409


@pytest.mark.parametrize("restore", [False, True])
def test_concurrent_requests_one_winner_and_atomic_rollback(collection, restore):
    app, client, _, _, _, album, ids, _ = collection
    if restore:
        change(client, ids[0])
    versions = {
        "expected_photo_revision": 2 if restore else 1,
        "expected_album_revision": 3 if restore else 2,
    }
    url = f"/api/v1/trash/photos/{ids[0]}/restore" if restore else f"/api/v1/photos/{ids[0]}/trash"
    headers = csrf(client)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(
            pool.map(lambda _: client.post(url, headers=headers, json=versions), range(4))
        )
    assert sorted(r.status_code for r in results) == [200, 409, 409, 409]
    if restore:
        change(client, ids[1])
    current = read(client, f"/trash/photos/{ids[1]}" if restore else f"/photos/{ids[1]}")

    def fail(conn, cursor, statement, parameters, context, many):
        if statement.startswith("UPDATE photos SET state="):
            raise OperationalError(statement, parameters, Exception("injected lifecycle failure"))

    event.listen(app.state.engine, "before_cursor_execute", fail)
    try:
        assert change(client, ids[1], restore=restore).status_code == 503
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail)
    assert read(client, f"/albums/{album}")["revision"] == current["album_revision"]
    with app.state.auth.sessions() as db:
        assert db.get(Photo, ids[1]).revision == current["revision"]
        assert db.get(Photo, ids[1]).state == ("trashed" if restore else "active")
    assert change(client, ids[1], restore=restore).status_code == 200


def test_account_isolation_auth_csrf_strict_versions_and_body_boundary(collection):
    _, client, settings, now, _, _, ids, _ = collection
    deleted = change(client, ids[0]).json()["data"]
    with TestClient(create_app(settings)) as other:
        other.app.state.auth.clock = lambda: now[0]
        assert other.get("/api/v1/trash/photos").status_code == 401
        signed_in(other, "Other_Traveler")
        assert read(other, "/trash/photos")["items"] == []
        for suffix in ("", "/original"):
            assert other.get(f"/api/v1/trash/photos/{ids[0]}{suffix}").status_code == 404
        for restore in (False, True):
            assert (
                change(
                    other,
                    ids[0],
                    restore=restore,
                    expected_photo_revision=2,
                    expected_album_revision=3,
                ).status_code
                == 404
            )
    for url in (f"/api/v1/photos/{ids[1]}/trash", f"/api/v1/trash/photos/{ids[0]}/restore"):
        assert client.post(url, json={}).status_code == 403
        for value in (0, True, "2", -1):
            assert (
                client.post(
                    url,
                    headers=csrf(client),
                    json={"expected_photo_revision": value, "expected_album_revision": 3},
                ).status_code
                == 422
            )
        assert (
            client.post(url, headers=csrf(client), content=b"x" * (16 * 1024 + 1)).status_code
            == 413
        )
        assert (
            client.post(
                url,
                headers=csrf(client),
                json={
                    "expected_photo_revision": 2,
                    "expected_album_revision": 3,
                    "owner_id": "forged",
                },
            ).status_code
            == 422
        )
    assert read(client, f"/trash/photos/{ids[0]}")["purge_after"] == deleted["purge_after"]


def test_pagination_ties_tampering_scope_changes_and_expiry(collection):
    app, client, settings, now, owner, album, ids, _ = collection
    more, _ = seed_photos(app, owner, album, 24)
    for photo in ids + more:
        assert change(client, photo).status_code == 200
    first = read(client, "/trash/photos")
    assert len(first["items"]) == 24 and first["photo_count"] == 27
    second = read(client, "/trash/photos?cursor=" + first["next_cursor"])
    assert {p["id"] for p in first["items"] + second["items"]} == set(ids + more)
    assert len(second["items"]) == 3 and second["next_cursor"] is None
    cursor = first["next_cursor"]
    assert client.get("/api/v1/trash/photos", params={"cursor": cursor + "x"}).status_code == 422
    for limit in (0, 101):
        assert client.get("/api/v1/trash/photos", params={"limit": limit}).status_code == 422
    with TestClient(create_app(settings)) as other:
        other.app.state.auth.clock = lambda: now[0]
        signed_in(other, "Cursor_Traveler")
        assert other.get("/api/v1/trash/photos", params={"cursor": cursor}).status_code == 422
    change(client, ids[0], restore=True)
    assert client.get("/api/v1/trash/photos", params={"cursor": cursor}).status_code == 409
    cursor = read(client, "/trash/photos")["next_cursor"]
    now[0] += RETENTION_MS
    client.cookies.clear()
    assert login(client, "Album_Traveler").status_code == 200
    assert client.get("/api/v1/trash/photos", params={"cursor": cursor}).status_code == 409


@pytest.mark.parametrize("missing", [True, False])
def test_unavailable_original_cannot_restore_and_rolls_back(collection, missing):
    app, client, settings, _, _, album, ids, _ = collection
    deleted = change(client, ids[0]).json()["data"]
    with app.state.auth.sessions() as db:
        path = private_path(settings.originals_dir, db.get(Photo, ids[0]).storage_key)
    # These are isolated, synthetic test files, never the user's photo directory.
    if missing:
        path.unlink()
    else:
        path.write_bytes(b"broken")
    assert client.get(deleted["original_url"]).status_code == 503
    assert change(client, ids[0], restore=True).status_code == 503
    assert read(client, f"/albums/{album}")["revision"] == deleted["album_revision"]
    assert read(client, f"/trash/photos/{ids[0]}")["revision"] == deleted["revision"]


def test_trashed_photo_cannot_edit_move_or_reorder(collection):
    _, client, _, _, _, album, ids, _ = collection
    change(client, ids[0])
    target = create(client, 2025).json()["data"]["id"]
    assert (
        client.patch(
            f"/api/v1/photos/{ids[0]}/note",
            headers=csrf(client),
            json={"note": "no", "expected_photo_revision": 2},
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/photos/{ids[0]}/move",
            headers=csrf(client),
            json={
                "target_album_id": target,
                "expected_photo_revision": 2,
                "expected_source_revision": 3,
                "expected_target_revision": 1,
            },
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/albums/{album}/reorder",
            headers=csrf(client),
            json={"photo_id": ids[0], "before_photo_id": None, "expected_album_revision": 3},
        ).status_code
        == 404
    )


def test_delete_and_restore_survive_app_restart(collection):
    _, client, settings, now, _, _, ids, contents = collection
    deleted = change(client, ids[0]).json()["data"]
    with TestClient(create_app(settings)) as restarted:
        restarted.app.state.auth.clock = lambda: now[0]
        restarted.cookies.update(client.cookies)
        assert read(restarted, f"/trash/photos/{ids[0]}") == deleted
        assert restarted.get(deleted["original_url"]).content == contents[0]
        assert change(restarted, ids[0], restore=True).status_code == 200
    with TestClient(create_app(settings)) as restarted:
        restarted.app.state.auth.clock = lambda: now[0]
        restarted.cookies.update(client.cookies)
        assert read(restarted, f"/photos/{ids[0]}")["ordinal"] == 3
        assert read(restarted, "/trash/photos")["items"] == []
