"""T07 uses synthetic originals and isolated databases, including failure injection."""

import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from photo_fixtures import seed_photos
from sqlalchemy import event, select, update
from sqlalchemy.exc import OperationalError
from test_albums import create, signed_in
from test_auth import csrf
from test_auth import environment as environment

from city_memories.main import create_app
from city_memories.models import Photo


@pytest.fixture
def editing_environment(environment, request):
    app, client, settings, now = environment
    signed_in(client)
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    album = create(client, 2026).json()["data"]
    ids, contents = seed_photos(app, owner, album["id"], getattr(request, "param", 4))
    return app, client, settings, now, album, ids, contents


def note(client, photo, text, revision=1):
    return client.patch(
        f"/api/v1/photos/{photo}/note", headers=csrf(client),
        json={"note": text, "expected_photo_revision": revision},
    )


def move(client, album, photo, before=None, revision=2):
    return client.post(
        f"/api/v1/albums/{album}/reorder", headers=csrf(client),
        json={"photo_id": photo, "before_photo_id": before, "expected_album_revision": revision},
    )


def order(client, album):
    return client.get(f"/api/v1/albums/{album}/photos?limit=100").json()["data"]


def test_note_plain_text_empty_unicode_versions_and_originals(editing_environment):
    app, client, _, _, album, ids, contents = editing_environment
    original = client.get(f"/api/v1/photos/{ids[0]}").json()["data"]
    text = "  <script>alert('not HTML')</script>\n深圳 🌅\n保留空格  "
    response = note(client, ids[0], text)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["data"] == {
        "id": ids[0], "album_id": album["id"], "note": text, "revision": 2, "has_note": True,
    }
    assert order(client, album["id"])["album_revision"] == 2
    assert note(client, ids[0], text, 2).json()["data"]["revision"] == 2
    assert note(client, ids[0], "stale text").status_code == 409
    assert note(client, ids[0], "🌅" * 2000, 2).status_code == 200
    cleared = note(client, ids[0], "", 3).json()["data"]
    assert cleared["revision"] == 4 and not cleared["has_note"]
    current = client.get(f"/api/v1/photos/{ids[0]}").json()["data"]
    for field in ("position", "original_filename", "original_url", "byte_size", "album_revision"):
        assert current[field] == original[field]
    assert client.get(current["original_url"]).content == contents[0]
    with app.state.auth.sessions() as db:
        assert db.get(Photo, ids[1]).revision == 1


@pytest.mark.parametrize("data", [
    {"note": "x" * 2001, "expected_photo_revision": 1},
    {"note": 12, "expected_photo_revision": 1},
    {"note": None, "expected_photo_revision": 1},
    {"note": "ok", "expected_photo_revision": True},
    {"note": "ok", "expected_photo_revision": 0},
    {"note": "ok", "expected_photo_revision": 1, "owner_id": "other"},
    {"note": "\ud800", "expected_photo_revision": 1},
])
def test_note_strict_validation(editing_environment, data):
    _, client, _, _, _, ids, _ = editing_environment
    response = client.patch(
        f"/api/v1/photos/{ids[0]}/note",
        headers={**csrf(client), "Content-Type": "application/json"}, content=json.dumps(data),
    )
    assert response.status_code == 422


@pytest.mark.parametrize("data", [
    {"photo_id": "missing", "before_photo_id": None, "expected_album_revision": True},
    {"photo_id": "missing", "expected_album_revision": 2},
    {"photo_id": "missing", "before_photo_id": None, "expected_album_revision": 0},
    {"photo_id": "missing", "before_photo_id": None, "expected_album_revision": 2, "ids": []},
])
def test_order_strict_validation(editing_environment, data):
    _, client, _, _, album, _, _ = editing_environment
    assert client.post(
        f"/api/v1/albums/{album['id']}/reorder", headers=csrf(client), json=data,
    ).status_code == 422


def test_json_size_and_csrf_before_mutation(editing_environment):
    _, client, _, _, album, ids, _ = editing_environment
    note_path = f"/api/v1/photos/{ids[0]}/note"
    order_path = f"/api/v1/albums/{album['id']}/reorder"
    assert client.patch(note_path, json={"note": "forged"}).status_code == 403
    assert client.post(order_path, json={}).status_code == 403
    headers = {**csrf(client), "Content-Type": "application/json"}
    # Escaped supplementary Unicode fits the documented 64 KiB JSON boundary.
    escaped = json.dumps({"note": "🌅" * 2000, "expected_photo_revision": 1})
    assert client.patch(note_path, headers=headers, content=escaped).status_code == 200
    for path, method, size in ((note_path, "PATCH", 65537), (order_path, "POST", 16385)):
        assert client.request(
            method, path, headers=headers, content=(b"x" * size for _ in range(1)),
        ).status_code == 413


@pytest.mark.parametrize("editing_environment", [27], indirect=True)
def test_complete_order_cross_page_cover_noops_and_note_binding(editing_environment):
    app, client, _, _, album, ids, contents = editing_environment
    first_page = client.get(f"/api/v1/albums/{album['id']}/photos").json()["data"]
    assert len(first_page["items"]) == 24
    assert note(client, ids[23], "文字跟随第 24 张").status_code == 200
    # The source crosses beyond the client's first 24 rows; all other IDs survive.
    response = move(client, album["id"], ids[23], ids[25])
    assert response.status_code == 200 and response.json()["data"]["album_revision"] == 3
    expected = ids[:23] + [ids[24], ids[23]] + ids[25:]
    assert [p["id"] for p in order(client, album["id"])["items"]] == expected
    assert client.get(
        f"/api/v1/albums/{album['id']}/photos", params={"cursor": first_page["next_cursor"]},
    ).status_code == 409
    assert move(client, album["id"], ids[-1], ids[0], 3).status_code == 200
    assert client.get(f"/api/v1/albums/{album['id']}").json()["data"]["cover_photo_id"] == ids[-1]
    assert move(client, album["id"], ids[-1], ids[0], 4).json()["data"]["changed"] is False
    assert move(client, album["id"], ids[-1], ids[-1], 4).json()["data"]["changed"] is False
    assert move(client, album["id"], ids[-1], None, 4).status_code == 200
    assert move(client, album["id"], ids[-1], None, 5).json()["data"]["changed"] is False
    with app.state.auth.sessions() as db:
        photos = db.scalars(select(Photo).order_by(Photo.position)).all()
        assert [p.position for p in photos] == list(range(27))
        assert db.get(Photo, ids[23]).note == "文字跟随第 24 张"
        assert db.get(Photo, ids[23]).revision == 2
        assert all(p.revision == 1 for p in photos if p.id != ids[23])
    assert client.get(f"/api/v1/photos/{ids[23]}/original").content == contents[23]


def test_ownership_wrong_album_anchors_and_trashed_rejected(editing_environment):
    app, client, _, now, album, ids, _ = editing_environment
    other_album = create(client, 2025).json()["data"]["id"]
    assert move(client, other_album, ids[0], None, 1).status_code == 404
    assert move(client, album["id"], ids[0], "missing").status_code == 404
    with TestClient(app) as other:
        signed_in(other, "Editing_Other")
        assert note(other, ids[0], "forged").status_code == 404
        assert move(other, album["id"], ids[0]).status_code == 404
    with app.state.auth.sessions.begin() as db:
        db.execute(update(Photo).where(Photo.id == ids[1]).values(
            state="trashed", position=None, deleted_at=now[0], purge_after=now[0] + 2592000000,
        ))
    assert note(client, ids[1], "trashed").status_code == 404
    assert move(client, album["id"], ids[1]).status_code == 404
    assert move(client, album["id"], ids[0], ids[1]).status_code == 404


def test_concurrent_note_writers_and_order_writers_each_have_one_winner(editing_environment):
    _, client, _, _, album, ids, _ = editing_environment
    headers = csrf(client)
    def write(index):
        return client.patch(f"/api/v1/photos/{ids[0]}/note", headers=headers, json={
            "note": f"writer {index}", "expected_photo_revision": 1,
        })
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(write, range(4)))
    assert sorted(r.status_code for r in results) == [200, 409, 409, 409]
    winner = next(r.json()["data"]["note"] for r in results if r.status_code == 200)
    assert client.get(f"/api/v1/photos/{ids[0]}").json()["data"]["note"] == winner
    def reorder_once(index):
        return client.post(f"/api/v1/albums/{album['id']}/reorder", headers=headers, json={
            "photo_id": ids[index], "before_photo_id": None if index == 0 else ids[0],
            "expected_album_revision": 2,
        })
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(reorder_once, range(4)))
    assert sorted(r.status_code for r in results) == [200, 409, 409, 409]
    assert order(client, album["id"])["album_revision"] == 3


def test_mid_reorder_failure_rolls_back_positions_and_revision(editing_environment):
    app, client, _, _, album, ids, _ = editing_environment
    writes = 0
    def fail_after_temporary_positions(conn, cursor, statement, parameters, context, many):
        nonlocal writes
        if statement.startswith("UPDATE photos SET position"):
            writes += 1
            if writes == len(ids) + 2:
                raise OperationalError(statement, parameters, Exception("injected failure"))
    event.listen(app.state.engine, "before_cursor_execute", fail_after_temporary_positions)
    try:
        assert move(client, album["id"], ids[0]).status_code == 503
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail_after_temporary_positions)
    result = order(client, album["id"])
    assert result["album_revision"] == 2
    assert [p["id"] for p in result["items"]] == ids
    assert [p["position"] for p in result["items"]] == list(range(len(ids)))
    assert move(client, album["id"], ids[0]).status_code == 200


def test_restart_persists_order_and_note_and_stale_replay_never_overwrites(editing_environment):
    _, client, settings, now, album, ids, contents = editing_environment
    assert note(client, ids[2], "重启保留文字").status_code == 200
    receipt = move(client, album["id"], ids[2], ids[0]).json()["data"]
    with TestClient(create_app(settings)) as restarted:
        restarted.app.state.auth.clock = lambda: now[0]
        restarted.cookies.update(client.cookies)
        assert [p["id"] for p in order(restarted, album["id"])["items"]] == [
            ids[2], ids[0], ids[1], ids[3],
        ]
        detail = restarted.get(f"/api/v1/photos/{ids[2]}").json()["data"]
        assert detail["note"] == "重启保留文字" and detail["ordinal"] == 1
        assert detail["revision"] == 2 and detail["album_revision"] == receipt["album_revision"]
        assert restarted.get(detail["original_url"]).content == contents[2]
        assert note(restarted, ids[2], "stale", 1).status_code == 409
        assert move(restarted, album["id"], ids[2], ids[0], 2).status_code == 409
