"""T08 tests use isolated databases and independent synthetic originals."""

import base64
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from photo_fixtures import seed_copies, seed_photos
from sqlalchemy import event, select, update
from sqlalchemy.exc import OperationalError
from test_albums import create, signed_in
from test_auth import csrf
from test_auth import environment as environment

from city_memories.main import create_app
from city_memories.models import Photo, UploadItem


@pytest.fixture
def organized(environment):
    app, client, settings, now = environment
    signed_in(client)
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    source = create(client, 2026).json()["data"]["id"]
    city = next(c for c in client.get("/api/v1/cities").json()["data"]["items"]
                if c["name"] == "广州市")
    target = client.post(f"/api/v1/cities/{city['id']}/albums", headers=csrf(client),
                         json={"year": None}).json()["data"]["id"]
    ids, contents = seed_photos(app, owner, source, 3)
    existing, _ = seed_photos(app, owner, target, 1)
    return app, client, settings, now, owner, source, target, ids, contents, existing


def move(client, photo, target, **versions):
    data = {"target_album_id": target, "expected_photo_revision": 1,
            "expected_source_revision": 2, "expected_target_revision": 2, **versions}
    return client.post(f"/api/v1/photos/{photo}/move", headers=csrf(client), json=data)


def detail(client, photo):
    return client.get(f"/api/v1/photos/{photo}").json()["data"]


def duplicate_page(client, album, **params):
    return client.get(f"/api/v1/albums/{album}/duplicates", params=params)


def test_move_appends_preserves_identity_bytes_note_receipt_and_statistics(organized):
    app, client, _, _, owner, source, target, ids, contents, existing = organized
    assert client.patch(
        f"/api/v1/photos/{ids[0]}/note", headers=csrf(client),
        json={"note": "跨城文字 🌅", "expected_photo_revision": 1},
    ).status_code == 200
    with app.state.auth.sessions() as db:
        before = db.get(Photo, ids[0])
        storage, upload = before.storage_key, before.upload_item_id
        batch_id = db.get(UploadItem, upload).batch_id
    response = move(client, ids[0], target, expected_photo_revision=2)
    assert response.status_code == 200
    result = response.json()["data"]
    assert result["source_revision"] == result["target_revision"] == 3
    assert result["target_duplicate_count"] == 2
    photo = detail(client, ids[0])
    assert photo["album_id"] == target and photo["revision"] == 3
    assert photo["ordinal"] == 2 and photo["previous_photo_id"] == existing[0]
    assert photo["note"] == "跨城文字 🌅" and photo["original_filename"] == "journey-01.png"
    assert client.get(photo["original_url"]).content == contents[0]
    with app.state.auth.sessions() as db:
        after = db.get(Photo, ids[0])
        assert (after.storage_key, after.upload_item_id) == (storage, upload)
        assert db.get(Photo, ids[1]).revision == 1
        assert db.scalar(select(Photo.id).where(Photo.owner_id == owner).limit(1))
    assert client.get(f"/api/v1/albums/{source}").json()["data"]["cover_photo_id"] == ids[1]
    assert duplicate_page(client, target).json()["data"]["photo_count"] == 2
    assert move(client, ids[0], target, expected_photo_revision=2).status_code == 409
    assert client.get(f"/api/v1/photos/{ids[0]}", params={"album_id": source}).status_code == 409
    replay = client.post(f"/api/v1/imports/{batch_id}/commit", headers=csrf(client),
                         json={"expected_album_revision": 1})
    assert replay.status_code == 200 and replay.json()["data"]["photo_ids"] == ids
    assert detail(client, ids[0])["album_id"] == target
    assert client.get(f"/api/v1/albums/{source}").json()["data"]["photo_count"] == 2


def test_last_photo_empty_album_and_city_remain_and_round_trip_order(organized):
    _, client, _, _, _, source, target, ids, _, existing = organized
    for index, photo in enumerate(ids):
        assert move(client, photo, target, expected_source_revision=2 + index,
                    expected_target_revision=2 + index).status_code == 200
    empty = client.get(f"/api/v1/albums/{source}").json()["data"]
    assert empty["photo_count"] == 0 and empty["cover_photo_id"] is None
    stats = client.get("/api/v1/me/atlas").json()["data"]
    assert stats["photo_count"] == 4 and stats["album_count"] == 2
    assert next(i for i in stats["items"] if i["city"]["id"] == empty["city"]["id"])["lit"] is False
    assert move(client, ids[0], source, expected_photo_revision=2,
                expected_source_revision=5, expected_target_revision=5).status_code == 200
    assert detail(client, ids[0])["position"] == 0
    assert detail(client, existing[0])["next_photo_id"] == ids[1]


@pytest.mark.parametrize("field,code", [
    ("expected_photo_revision", "PHOTO_CHANGED"), ("expected_source_revision", "SOURCE_CHANGED"),
    ("expected_target_revision", "TARGET_CHANGED"),
])
def test_each_stale_version_refuses_without_partial_changes(organized, field, code):
    _, client, _, _, _, source, target, ids, _, _ = organized
    response = move(client, ids[0], target, **{field: 99})
    assert response.status_code == 409 and response.json()["error"]["code"] == code
    assert detail(client, ids[0])["album_id"] == source
    assert client.get(f"/api/v1/albums/{target}").json()["data"]["revision"] == 2


@pytest.mark.parametrize("extra", [
    {"expected_photo_revision": True}, {"expected_source_revision": "2"},
    {"expected_target_revision": 0}, {"target_album_id": None}, {"owner_id": "forged"},
])
def test_move_strict_input(organized, extra):
    _, client, _, _, _, _, target, ids, _, _ = organized
    data = {"target_album_id": target, "expected_photo_revision": 1,
            "expected_source_revision": 2, "expected_target_revision": 2, **extra}
    assert client.post(
        f"/api/v1/photos/{ids[0]}/move", headers=csrf(client), json=data
    ).status_code == 422


def test_move_and_duplicates_auth_csrf_same_album_and_trashed(organized):
    app, client, _, now, _, source, target, ids, _, _ = organized
    assert move(client, ids[0], source).json()["error"]["code"] == "SAME_ALBUM"
    assert move(client, ids[0], "missing").status_code == 404
    assert client.post(f"/api/v1/photos/{ids[0]}/move", json={}).status_code == 403
    assert client.post(f"/api/v1/photos/{ids[0]}/move", headers=csrf(client),
                       content=(b"x" * 16385 for _ in range(1))).status_code == 413
    with TestClient(app) as other:
        assert duplicate_page(other, source).status_code == 401
        signed_in(other, "Organize_Other")
        foreign = create(other, 2026).json()["data"]["id"]
        assert duplicate_page(other, source).status_code == 404
        assert move(other, ids[0], foreign).status_code == 404
        assert move(client, ids[0], foreign).status_code == 404
    with app.state.auth.sessions.begin() as db:
        db.execute(update(Photo).where(Photo.id == ids[1]).values(
            state="trashed", position=None, deleted_at=now[0], purge_after=now[0] + 2592000000,
        ))
    assert move(client, ids[1], target).status_code == 404


def test_concurrent_moves_one_winner_and_atomic_rollback(organized):
    app, client, _, _, _, source, target, ids, _, _ = organized
    headers = csrf(client)
    def concurrent(_):
        return client.post(f"/api/v1/photos/{ids[0]}/move", headers=headers, json={
            "target_album_id": target, "expected_photo_revision": 1,
            "expected_source_revision": 2, "expected_target_revision": 2,
        })
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(concurrent, range(4)))
    assert sorted(r.status_code for r in results) == [200, 409, 409, 409]
    def fail_photo_update(conn, cursor, statement, parameters, context, many):
        if statement.startswith("UPDATE photos SET album_id"):
            raise OperationalError(statement, parameters, Exception("injected move failure"))
    event.listen(app.state.engine, "before_cursor_execute", fail_photo_update)
    try:
        assert move(client, ids[1], target, expected_source_revision=3,
                    expected_target_revision=3).status_code == 503
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail_photo_update)
    assert detail(client, ids[1])["album_id"] == source
    assert client.get(f"/api/v1/albums/{source}").json()["data"]["revision"] == 3
    assert client.get(f"/api/v1/albums/{target}").json()["data"]["revision"] == 3
    assert move(client, ids[1], target, expected_source_revision=3,
                expected_target_revision=3).status_code == 200


def test_duplicate_groups_bound_pages_no_hash_same_names_not_equivalent(organized):
    app, client, _, _, owner, source, target, ids, contents, _ = organized
    # One large group crosses a page; distinct contents may share a filename.
    copies = seed_copies(app, owner, source, [contents[0]] * 26 + [contents[1]],
                         ["different-name.png"] * 26 + ["journey-01.png"])
    page = duplicate_page(client, source).json()["data"]
    assert page["group_count"] == 2 and page["photo_count"] == 29
    assert sum(len(g["photos"]) for g in page["items"]) == 24
    payload = base64.urlsafe_b64decode(page["next_cursor"].split('.')[0]).decode()
    with app.state.auth.sessions() as db:
        hashes = db.scalars(select(Photo.sha256)).all()
    assert all(value not in payload for value in hashes)
    collected = page["items"][:]
    while page["next_cursor"]:
        page = duplicate_page(client, source, cursor=page["next_cursor"]).json()["data"]
        collected.extend(page["items"])
    seen = [p["id"] for g in collected for p in g["photos"]]
    assert len(seen) == len(set(seen)) == 29
    assert set(seen) == {ids[0], ids[1], *copies}
    response = duplicate_page(client, source)
    assert response.headers["cache-control"] == "private, no-store"
    assert all(field not in response.text for field in ("sha256", "storage_key", "owner_id"))
    assert all(value not in response.text for value in hashes)
    assert duplicate_page(client, target).json()["data"]["items"] == []


def test_duplicate_cursor_scope_tampering_and_movement_invalidation(organized):
    app, client, _, _, owner, source, target, ids, contents, _ = organized
    seed_copies(app, owner, source, [contents[0]] * 2, ["a.png", "b.png"])
    cursor = duplicate_page(client, source, limit=1).json()["data"]["next_cursor"]
    assert duplicate_page(client, target, cursor=cursor).status_code == 422
    assert duplicate_page(client, source, cursor=cursor + "x").status_code == 422
    assert duplicate_page(client, source, limit=0).status_code == 422
    assert duplicate_page(client, source, limit=101).status_code == 422
    assert move(client, ids[0], target, expected_source_revision=3).status_code == 200
    assert duplicate_page(client, source, cursor=cursor).status_code == 409


def test_moved_original_and_duplicate_groups_persist_after_restart(organized):
    _, client, settings, now, _, source, target, ids, contents, _ = organized
    assert move(client, ids[0], target).status_code == 200
    with TestClient(create_app(settings)) as restarted:
        restarted.app.state.auth.clock = lambda: now[0]
        restarted.cookies.update(client.cookies)
        assert detail(restarted, ids[0])["album_id"] == target
        assert duplicate_page(restarted, target).json()["data"]["photo_count"] == 2
        assert restarted.get(f"/api/v1/photos/{ids[0]}/original").content == contents[0]
        assert restarted.get(f"/api/v1/albums/{source}").json()["data"]["photo_count"] == 2
