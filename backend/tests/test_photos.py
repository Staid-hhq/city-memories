import base64
import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient
from photo_fixtures import seed_photos
from sqlalchemy import event, update
from test_albums import create, signed_in
from test_auth import csrf
from test_auth import environment as environment

from city_memories.models import Album, Photo


@pytest.fixture
def photos_environment(environment):
    app, client, settings, now = environment
    signed_in(client)
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    album = create(client, 2026).json()["data"]
    ids, contents = seed_photos(app, owner, album["id"])
    return app, client, settings, now, album, ids, contents


def test_ordered_pagination_defaults_whitelist_and_originals(photos_environment):
    app, client, _, _, album, ids, contents = photos_environment
    path = f"/api/v1/albums/{album['id']}/photos"
    first = client.get(path)
    assert first.status_code == 200 and first.headers["cache-control"] == "private, no-store"
    data = first.json()["data"]
    assert data["photo_count"] == 27 and data["album_revision"] == 2
    assert [p["id"] for p in data["items"]] == ids[:24]
    second = client.get(path, params={"cursor": data["next_cursor"]}).json()["data"]
    assert [p["id"] for p in second["items"]] == ids[24:] and second["next_cursor"] is None
    all_photos = client.get(path, params={"limit": 100}).json()["data"]
    assert [p["id"] for p in all_photos["items"]] == ids
    assert set(data["items"][0]) == {
        "id",
        "album_id",
        "original_filename",
        "mime_type",
        "byte_size",
        "width",
        "height",
        "position",
        "revision",
        "has_note",
        "original_url",
    }
    for index in (0, 24, 26):
        row = all_photos["items"][index]
        assert client.get(row["original_url"]).content == contents[index]
    with app.state.auth.sessions() as db:
        photo = db.get(Photo, ids[0])
        for private in (photo.storage_key, photo.sha256, photo.owner_id, photo.upload_item_id):
            assert private not in first.text


def test_neighbors_cross_page_boundaries_and_read_only_note(photos_environment):
    app, client, _, _, album, ids, _ = photos_environment
    with app.state.auth.sessions.begin() as db:
        db.execute(
            update(Photo)
            .where(Photo.id == ids[23])
            .values(note="<script>not executable</script>\n旅行记录")
        )
    for index in (0, 23, 24, 26):
        response = client.get(
            f"/api/v1/photos/{ids[index]}",
            params={"album_id": album["id"], "expected_album_revision": 2},
        )
        assert (
            response.status_code == 200 and response.headers["cache-control"] == "private, no-store"
        )
        data = response.json()["data"]
        assert data["previous_photo_id"] == (ids[index - 1] if index else None)
        assert data["next_photo_id"] == (ids[index + 1] if index < 26 else None)
        assert data["ordinal"] == index + 1 and data["photo_count"] == 27
        if index == 23:
            assert data["has_note"] and data["note"].startswith("<script>")


def test_empty_missing_and_trashed_photos(photos_environment):
    app, client, _, now, album, ids, _ = photos_environment
    empty = create(client, None).json()["data"]
    data = client.get(f"/api/v1/albums/{empty['id']}/photos").json()["data"]
    assert data == {"items": [], "next_cursor": None, "album_revision": 1, "photo_count": 0}
    with app.state.auth.sessions.begin() as db:
        db.execute(
            update(Photo)
            .where(Photo.id == ids[1])
            .values(
                state="trashed", position=None, deleted_at=now[0], purge_after=now[0] + 2592000000
            )
        )
        db.execute(update(Album).where(Album.id == album["id"]).values(revision=3))
    assert client.get(f"/api/v1/photos/{ids[1]}").status_code == 404
    assert client.get(f"/api/v1/photos/{ids[1]}/original").status_code == 404
    detail = client.get(f"/api/v1/photos/{ids[0]}").json()["data"]
    assert detail["next_photo_id"] == ids[2] and detail["photo_count"] == 26
    assert client.get("/api/v1/photos/missing").status_code == 404
    assert client.get("/api/v1/albums/missing/photos").status_code == 404


@pytest.mark.parametrize(
    "query", ["limit=0", "limit=101", "limit=no", "cursor=invalid", "cursor=" + "x" * 1025]
)
def test_paging_validation(photos_environment, query):
    _, client, _, _, album, _, _ = photos_environment
    assert client.get(f"/api/v1/albums/{album['id']}/photos?{query}").status_code == 422


def test_cursor_scope_tampering_and_version_conflicts(photos_environment):
    app, client, _, _, album, ids, _ = photos_environment
    path = f"/api/v1/albums/{album['id']}/photos"
    cursor = client.get(path).json()["data"]["next_cursor"]
    assert client.get(path, params={"cursor": cursor + "x"}).status_code == 422
    other_album = create(client, 2025).json()["data"]["id"]
    assert (
        client.get(f"/api/v1/albums/{other_album}/photos", params={"cursor": cursor}).status_code
        == 422
    )
    with app.state.auth.sessions.begin() as db:
        db.execute(update(Album).where(Album.id == album["id"]).values(revision=3))
    response = client.get(path, params={"cursor": cursor})
    assert response.status_code == 409 and response.json()["error"]["code"] == "ALBUM_CHANGED"
    assert client.get(f"/api/v1/photos/{ids[0]}?expected_album_revision=2").status_code == 409
    assert client.get(f"/api/v1/photos/{ids[0]}?album_id={other_album}").status_code == 409
    assert client.get(f"/api/v1/photos/{ids[0]}?expected_album_revision=3").status_code == 200


@pytest.mark.parametrize(
    "keys", [[True, [0, "id"]], [2, "invalid"], [2, [-1, "id"]], [2, [0, None]]]
)
def test_signed_cursor_shape_validation(photos_environment, keys):
    app, client, _, _, album, _, _ = photos_environment
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    payload = base64.urlsafe_b64encode(json.dumps([f"photos:{owner}:{album['id']}", keys]).encode())
    signature = hmac.new(app.state.auth.secret, payload, hashlib.sha256).hexdigest()
    response = client.get(
        f"/api/v1/albums/{album['id']}/photos",
        params={"cursor": payload.decode() + "." + signature},
    )
    assert response.status_code == 422


def test_accounts_sessions_and_private_cursor_isolation(photos_environment):
    app, client, _, _, album, ids, _ = photos_environment
    path = f"/api/v1/albums/{album['id']}/photos"
    cursor = client.get(path).json()["data"]["next_cursor"]
    with TestClient(app) as other:
        signed_in(other, "Photos_Other")
        assert other.get(path).status_code == 404
        assert other.get(f"/api/v1/photos/{ids[0]}").status_code == 404
        assert other.get(f"/api/v1/photos/{ids[0]}/original").status_code == 404
        own = create(other, 2026).json()["data"]["id"]
        assert (
            other.get(f"/api/v1/albums/{own}/photos", params={"cursor": cursor}).status_code == 422
        )
    cookie = client.cookies.get("city_memories_session")
    client.post("/api/v1/auth/logout", headers=csrf(client))
    client.cookies.set("city_memories_session", cookie)
    assert client.get(path).status_code == 401
    assert client.get(f"/api/v1/photos/{ids[0]}").status_code == 401


def test_read_snapshot_stays_consistent_during_concurrent_album_update(photos_environment):
    app, client, _, _, album, _, _ = photos_environment
    changed = []

    def change_after_album_read(_connection, _cursor, statement, _params, _context, _many):
        if not changed and statement.startswith("SELECT albums.") and "FROM albums" in statement:
            changed.append(True)
            with app.state.engine.begin() as connection:
                connection.execute(update(Album).where(Album.id == album["id"]).values(revision=3))

    event.listen(app.state.engine, "after_cursor_execute", change_after_album_read)
    try:
        data = client.get(f"/api/v1/albums/{album['id']}/photos").json()["data"]
    finally:
        event.remove(app.state.engine, "after_cursor_execute", change_after_album_read)
    assert changed and data["album_revision"] == 2
    assert (
        client.get(
            f"/api/v1/albums/{album['id']}/photos", params={"cursor": data["next_cursor"]}
        ).status_code
        == 409
    )
