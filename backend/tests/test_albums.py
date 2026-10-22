from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from photo_fixtures import seed_photos
from sqlalchemy import func, select, update
from sqlalchemy.exc import OperationalError
from starlette.requests import Request
from test_auth import csrf, login, register
from test_auth import environment as environment

from city_memories.albums import encode_cursor
from city_memories.auth import COOKIE_NAME
from city_memories.config import get_settings
from city_memories.main import create_app
from city_memories.models import Album, City, ImportBatch, Photo, UploadItem

SHENZHEN = "a03b8f10-06dd-4b56-aef1-33cfc3696301"
GUANGZHOU = "a03b8f10-06dd-4b56-aef1-33cfc3696302"


def signed_in(client, name="Album_Traveler"):
    assert register(client, name).status_code == 201
    assert login(client, name).status_code == 200


def create(client, year, city=SHENZHEN, **extra):
    return client.post(
        f"/api/v1/cities/{city}/albums", headers=csrf(client), json={"year": year, **extra}
    )


def test_reviewed_catalog_search_pagination_and_literal_wildcards(environment):
    _, client, _, _ = environment
    signed_in(client)
    all_cities = client.get("/api/v1/cities").json()["data"]["items"]
    assert len(all_cities) == 24
    assert all(city["can_create"] for city in all_cities)
    first = client.get("/api/v1/cities?limit=100").json()["data"]
    collected = first["items"]
    while first["next_cursor"]:
        first = client.get(
            "/api/v1/cities", params={"limit": 100, "cursor": first["next_cursor"]}
        ).json()["data"]
        collected += first["items"]
    assert collected[:24] == all_cities
    assert len(collected) == len({c["id"] for c in collected}) == 391
    assert {"深圳市", "广州市", "贺州市"} <= {c["name"] for c in collected}
    assert len(client.get("/api/v1/cities?q=广东").json()["data"]["items"]) == 21
    assert client.get("/api/v1/cities?q= 深圳 ").json()["data"]["items"][0]["id"] == SHENZHEN
    for q in ("不存在", "%", "_", "' OR 1=1 --"):
        assert client.get("/api/v1/cities", params={"q": q}).json()["data"]["items"] == []
    cursor = client.get("/api/v1/cities?limit=1").json()["data"]["next_cursor"]
    assert client.get("/api/v1/cities", params={"q": "广东", "cursor": cursor}).status_code == 422
    assert client.get("/api/v1/cities", params={"cursor": cursor + "x"}).status_code == 422


def test_empty_albums_order_duplicates_and_atlas(environment):
    app, client, _, _ = environment
    signed_in(client)
    assert client.get("/api/v1/me/atlas").json()["data"] == {
        "items": [],
        "album_count": 0,
        "photo_count": 0,
    }
    assert client.get(f"/api/v1/cities/{SHENZHEN}/albums").json()["data"]["items"] == []
    ids = {}
    for year in (None, 2024, 2026, 1, 9999):
        response = create(client, year)
        assert response.status_code == 201
        album = response.json()["data"]
        ids[year] = album["id"]
        assert album["created"] is True and album["photo_count"] == 0
        assert album["cover_photo_id"] is None and album["original_url"] is None
        assert album["created_at"].endswith(("Z", "+00:00"))
        assert "owner_id" not in album and "storage_key" not in response.text
    with app.state.auth.sessions.begin() as db:
        db.execute(update(Album).where(Album.id == ids[2026]).values(revision=7, updated_at=99))
    for year in (None, 2026):
        result = create(client, year)
        assert result.status_code == 200
        assert result.json()["data"]["created"] is False
        assert result.json()["data"]["id"] == ids[year]
    assert create(client, 2026).json()["data"]["revision"] == 7
    result = client.get(f"/api/v1/cities/{SHENZHEN}/albums").json()["data"]
    assert [album["year"] for album in result["items"]] == [9999, 2026, 2024, 1, None]
    atlas = client.get("/api/v1/me/atlas").json()["data"]
    assert atlas["album_count"] == 5 and atlas["photo_count"] == 0
    assert atlas["items"][0]["lit"] is False
    assert atlas["items"][0]["city"]["id"] == SHENZHEN
    assert create(client, 2026, GUANGZHOU).json()["data"]["id"] != ids[2026]


def test_my_albums_default_page_and_cross_city_keyset_order(environment):
    app, client, _, now = environment
    signed_in(client)
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    records = []
    with app.state.auth.sessions.begin() as db:
        for index, year in enumerate([*range(2000, 2026), 2025, None]):
            identifier = str(uuid4())
            records.append((identifier, year))
            db.add(Album(
                id=identifier, owner_id=owner,
                city_id=GUANGZHOU if index == 26 else SHENZHEN,
                year=year, revision=1, created_at=now[0], updated_at=now[0],
            ))
    expected = [identifier for identifier, _ in sorted(
        records, key=lambda item: (-(item[1] or 0), item[0])
    )]
    first = client.get("/api/v1/me/albums").json()["data"]
    assert len(first["items"]) == 24 and first["next_cursor"]
    assert [album["id"] for album in first["items"]] == expected[:24]
    second = client.get(
        "/api/v1/me/albums", params={"cursor": first["next_cursor"]}
    ).json()["data"]
    assert [album["id"] for album in first["items"] + second["items"]] == expected
    assert second["items"][-1]["year"] is None and second["next_cursor"] is None
    assert all(album["cover_photo_id"] is None for album in first["items"])
    assert not any(name in str(first) for name in ("owner_id", "preferred_cover_photo_id"))
    assert client.get("/api/v1/me/albums?limit=0").status_code == 422
    assert client.get("/api/v1/me/albums?limit=101").status_code == 422


def test_my_albums_cursor_account_scope_and_insert_before_page(environment):
    app, client, _, _ = environment
    signed_in(client)
    assert client.get("/api/v1/me/albums").json()["data"] == {
        "items": [], "next_cursor": None,
    }
    ids = [create(client, year).json()["data"]["id"] for year in (2026, 2024, None)]
    first = client.get("/api/v1/me/albums?limit=1").json()["data"]
    create(client, 2025, GUANGZHOU)
    second = client.get(
        "/api/v1/me/albums", params={"cursor": first["next_cursor"]}
    ).json()["data"]
    assert [a["year"] for a in second["items"]] == [2025, 2024, None]
    assert first["items"][0]["id"] not in {a["id"] for a in second["items"]}
    city_cursor = client.get(
        f"/api/v1/cities/{SHENZHEN}/albums?limit=1"
    ).json()["data"]["next_cursor"]
    for cursor in (city_cursor, first["next_cursor"] + "x"):
        assert client.get("/api/v1/me/albums", params={"cursor": cursor}).status_code == 422
    with TestClient(app) as other:
        assert other.get("/api/v1/me/albums").status_code == 401
        signed_in(other, "All_Albums_Other")
        own = create(other, 2026, GUANGZHOU).json()["data"]["id"]
        assert [a["id"] for a in other.get("/api/v1/me/albums").json()["data"]["items"]] == [own]
        assert other.get(
            "/api/v1/me/albums", params={"cursor": first["next_cursor"]}
        ).status_code == 422
    with app.state.auth.sessions.begin() as db:
        db.get(City, SHENZHEN).is_active = 0
    history = client.get("/api/v1/me/albums").json()["data"]["items"]
    assert set(ids) <= {a["id"] for a in history}
    assert all(not a["city"]["can_create"] for a in history if a["city"]["id"] == SHENZHEN)


def test_my_albums_recent_order_keyset_and_default_compatibility(environment):
    app, client, _, now = environment
    signed_in(client)
    assert client.get("/api/v1/me/albums?sort=recent").json()["data"] == {
        "items": [], "next_cursor": None,
    }
    records = []
    for index, year in enumerate((9999, 2026, 2025, None, 1)):
        identifier = create(client, year).json()["data"]["id"]
        updated_at = now[0] + (30, 10, 20, 30, 10)[index]
        records.append((identifier, year, updated_at))
        with app.state.auth.sessions.begin() as db:
            db.get(Album, identifier).updated_at = updated_at
    expected = [row[0] for row in sorted(records, key=lambda row: (-row[2], row[0]))]
    first = client.get("/api/v1/me/albums?sort=recent&limit=2").json()["data"]
    collected = first["items"]
    page = first
    while page["next_cursor"]:
        page = client.get("/api/v1/me/albums", params={
            "sort": "recent", "limit": 2, "cursor": page["next_cursor"],
        }).json()["data"]
        collected += page["items"]
    assert [album["id"] for album in collected] == expected
    assert len(collected) == len({album["id"] for album in collected}) == 5
    assert [album["id"] for album in client.get(
        "/api/v1/me/albums?sort=recent&limit=3"
    ).json()["data"]["items"]] == expected[:3]
    default = client.get("/api/v1/me/albums?limit=2").json()["data"]
    assert default == client.get("/api/v1/me/albums?sort=year&limit=2").json()["data"]
    assert [album["year"] for album in default["items"]] == [9999, 2026]
    for sort, cursor in (("year", first["next_cursor"]), ("recent", default["next_cursor"])):
        response = client.get("/api/v1/me/albums", params={"sort": sort, "cursor": cursor})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_CURSOR"


def test_my_albums_recent_cursor_is_account_scoped_and_validated(environment):
    app, client, _, _ = environment
    signed_in(client)
    for year in (2026, 2025):
        create(client, year)
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    cursor = client.get("/api/v1/me/albums?sort=recent&limit=1").json()["data"]["next_cursor"]
    assert cursor
    with TestClient(app) as other:
        assert other.get("/api/v1/me/albums?sort=recent").status_code == 401
        signed_in(other, "Recent_Albums_Other")
        own = create(other, 2024, GUANGZHOU).json()["data"]["id"]
        assert [album["id"] for album in other.get(
            "/api/v1/me/albums?sort=recent"
        ).json()["data"]["items"]] == [own]
        assert other.get("/api/v1/me/albums", params={
            "sort": "recent", "cursor": cursor,
        }).status_code == 422
    request = Request({"type": "http", "app": app})
    for keys in (
        [-1, "album"], [True, "album"], [1.5, "album"], ["1", "album"],
        [2**63, "album"], [1, ""], [1, "x" * 37], [1, "album", "extra"],
    ):
        invalid = encode_cursor(request, f"my-albums:{owner}:recent", keys)
        response = client.get("/api/v1/me/albums", params={"sort": "recent", "cursor": invalid})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_CURSOR"
    assert client.get("/api/v1/me/albums", params={
        "sort": "recent", "cursor": cursor + "x",
    }).status_code == 422
    assert client.get("/api/v1/me/albums?sort=unknown").status_code == 422


def test_my_albums_filters_cover_all_pages_and_combine_with_both_orders(environment):
    app, client, _, now = environment
    signed_in(client)
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    records = []
    with app.state.auth.sessions.begin() as db:
        outside = db.scalar(select(City.id).where(City.name == "北京市"))
        for index, (city, year) in enumerate([
            *((SHENZHEN, year) for year in range(2000, 2028)),
            (GUANGZHOU, 2026), (GUANGZHOU, 2025), (GUANGZHOU, None),
            (outside, 2026), (outside, None),
        ]):
            identifier = str(uuid4())
            updated_at = now[0] + index // 2
            records.append((identifier, city, year, updated_at))
            db.add(Album(
                id=identifier, owner_id=owner, city_id=city, year=year,
                revision=1, created_at=now[0], updated_at=updated_at,
            ))
    matching = [row for row in records if row[1] in (SHENZHEN, GUANGZHOU)]
    for sort, order_index in (("year", 2), ("recent", 3)):
        expected = [row[0] for row in sorted(
            matching, key=lambda row: (-(row[order_index] or 0), row[0])
        )]
        params = {"q": "广东", "sort": sort, "limit": 7}
        page = client.get("/api/v1/me/albums", params=params).json()["data"]
        collected = page["items"]
        while page["next_cursor"]:
            page = client.get("/api/v1/me/albums", params={
                **params, "cursor": page["next_cursor"],
            }).json()["data"]
            collected += page["items"]
        assert len(collected) == 31
        assert [album["id"] for album in collected] == expected
        assert len({album["id"] for album in collected}) == len(collected)
        assert all(album["photo_count"] == 0 for album in collected)
    for params, expected in (
        ({"q": "深圳", "year": "2026"}, {(SHENZHEN, 2026)}),
        ({"q": "广东", "year": "2026"}, {(SHENZHEN, 2026), (GUANGZHOU, 2026)}),
        ({"q": "广东", "year": "unmarked"}, {(GUANGZHOU, None)}),
        ({"q": "深圳", "year": "unmarked"}, set()),
        ({"year": "unmarked"}, {(GUANGZHOU, None), (outside, None)}),
    ):
        response = client.get("/api/v1/me/albums", params=params)
        assert response.status_code == 200
        assert {(a["city"]["id"], a["year"]) for a in response.json()["data"]["items"]} == expected


def test_my_albums_filtered_cursor_binds_normalized_conditions_and_owner(environment):
    app, client, _, _ = environment
    signed_in(client)
    for city in (SHENZHEN, GUANGZHOU):
        for year in (2026, 2025, None):
            create(client, year, city)
    path = "/api/v1/me/albums"
    params = {"q": " 广东 ", "year": "2026", "limit": 1}
    first = client.get(path, params=params).json()["data"]
    cursor = first["next_cursor"]
    assert cursor
    second = client.get(path, params={
        "q": "广东", "year": "2026", "cursor": cursor,
    }).json()["data"]
    assert len(second["items"]) == 1 and second["next_cursor"] is None
    assert second["items"][0]["id"] != first["items"][0]["id"]
    for conditions in (
        {}, {"q": "广东"}, {"year": "2026"}, {"q": "深圳", "year": "2026"},
        {"q": "广东", "year": "2025"}, {"q": "广东", "year": "unmarked"},
        {"q": "广东", "year": "2026", "sort": "recent"},
    ):
        response = client.get(path, params={**conditions, "cursor": cursor})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_CURSOR"
    for sort in ("year", "recent"):
        unfiltered = client.get(path, params={"sort": sort, "limit": 1}).json()["data"]
        old_cursor = unfiltered["next_cursor"]
        assert client.get(path, params={
            "sort": sort, "q": " \t ", "cursor": old_cursor,
        }).status_code == 200
        assert client.get(path, params={
            "sort": sort, "q": "广东", "cursor": old_cursor,
        }).status_code == 422
    with TestClient(app) as other:
        signed_in(other, "Filtered_Albums_Other")
        own = create(other, 2026).json()["data"]["id"]
        assert [album["id"] for album in other.get(path, params=params).json()["data"][
            "items"
        ]] == [own]
        assert other.get(path, params={**params, "cursor": cursor}).status_code == 422


def test_my_albums_search_treats_wildcards_literally_and_long_unicode_cursor_is_usable(environment):
    app, client, _, _ = environment
    signed_in(client)
    expected = {create(client, year).json()["data"]["id"] for year in (2026, 2025)}
    create(client, 2026, GUANGZHOU)
    path = "/api/v1/me/albums"
    for q in ("%", "_", "' OR 1=1 --"):
        assert client.get(path, params={"q": q}).json()["data"]["items"] == []
    long_name = "合成" * 40
    with app.state.auth.sessions.begin() as db:
        city = db.get(City, SHENZHEN)
        city.name = "合成%_城市/样本"
        city.parent_name = long_name
    for q in ("%", "_", "/", "%_", long_name):
        first = client.get(path, params={"q": q, "limit": 1}).json()["data"]
        assert first["next_cursor"] and len(first["next_cursor"]) <= 1024
        second = client.get(path, params={
            "q": q, "cursor": first["next_cursor"], "limit": 1,
        }).json()["data"]
        assert {a["id"] for a in first["items"] + second["items"]} == expected
        assert second["next_cursor"] is None


def test_my_album_options_include_all_owned_years_and_historical_empty_albums(environment):
    app, client, _, _ = environment
    path = "/api/v1/me/albums/options"
    assert client.get(path).status_code == 401
    signed_in(client)
    assert client.get(path).json()["data"] == {"years": []}
    for city, year in (
        (SHENZHEN, None), (SHENZHEN, 2026), (GUANGZHOU, 2026),
        (SHENZHEN, 2024), (SHENZHEN, 1), (GUANGZHOU, 9999),
    ):
        assert create(client, year, city).status_code == 201
    with TestClient(app) as other:
        signed_in(other, "Options_Albums_Other")
        assert other.get(path).json()["data"] == {"years": []}
        create(other, 2025)
        assert other.get(path).json()["data"] == {"years": [2025]}
    assert len(client.get("/api/v1/me/albums?limit=1").json()["data"]["items"]) == 1
    assert client.get("/api/v1/me/albums?q=没有这个城市").json()["data"]["items"] == []
    with app.state.auth.sessions.begin() as db:
        city = db.get(City, SHENZHEN)
        city.is_active = 0
        city.mapping_status = "pending"
    response = client.get(path)
    assert response.status_code == 200
    assert response.json()["data"] == {"years": [9999, 2026, 2024, 1, None]}
    assert response.headers["cache-control"] == "private, no-store"
    assert all(not a["city"]["can_create"] for a in client.get(
        "/api/v1/me/albums?q=深圳"
    ).json()["data"]["items"])


def test_my_albums_reject_invalid_filter_parameters(environment):
    _, client, _, _ = environment
    signed_in(client)
    for params in (
        {"q": "城" * 81}, {"year": ""}, {"year": "0"}, {"year": "-1"},
        {"year": "10000"}, {"year": "true"}, {"year": "2026.0"}, {"year": "1e3"},
        {"year": "null"}, {"year": "unmarked "}, {"year": "２０２６"},
    ):
        response = client.get("/api/v1/me/albums", params=params)
        assert response.status_code == 422, params
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"


@pytest.fixture
def cover_collection(environment):
    app, client, settings, now = environment
    signed_in(client)
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    album = create(client, 2026).json()["data"]["id"]
    photos, _ = seed_photos(app, owner, album, 3)
    return app, client, settings, now, owner, album, photos


def set_cover(client, album, photo, revision=None):
    if revision is None:
        revision = client.get(f"/api/v1/albums/{album}").json()["data"]["revision"]
    return client.patch(
        f"/api/v1/albums/{album}/cover", headers=csrf(client),
        json={"photo_id": photo, "expected_revision": revision},
    )


def test_recent_albums_promote_changed_cover_but_not_same_selection(cover_collection):
    _, client, _, now, _, album, photos = cover_collection
    now[0] += 10
    newer = create(client, 2025, GUANGZHOU).json()["data"]["id"]
    path = "/api/v1/me/albums?sort=recent&limit=1"
    assert client.get(path).json()["data"]["items"][0]["id"] == newer
    now[0] += 10
    assert set_cover(client, album, photos[1]).status_code == 200
    assert client.get(path).json()["data"]["items"][0]["id"] == album
    now[0] += 10
    newest = create(client, 2024).json()["data"]["id"]
    now[0] += 10
    assert set_cover(client, album, photos[1]).status_code == 200
    assert client.get(path).json()["data"]["items"][0]["id"] == newest


def test_selected_cover_persists_reset_and_same_selection_is_idempotent(cover_collection):
    _, client, settings, now, _, album, photos = cover_collection
    before = client.get(f"/api/v1/albums/{album}").json()["data"]
    assert before["cover_photo_id"] == photos[0]
    now[0] += 10
    response = set_cover(client, album, photos[2], before["revision"])
    assert response.status_code == 200
    selected = response.json()["data"]
    assert selected["cover_photo_id"] == photos[2]
    assert selected["original_url"] == f"/api/v1/photos/{photos[2]}/original"
    assert selected["revision"] == before["revision"] + 1
    assert selected["updated_at"] != before["updated_at"]
    assert response.headers["cache-control"] == "private, no-store"
    assert set_cover(client, album, photos[2]).json()["data"]["revision"] == selected["revision"]
    with TestClient(create_app(settings)) as restarted:
        assert login(restarted, "Album_Traveler").status_code == 200
        recovered = restarted.get(f"/api/v1/albums/{album}").json()["data"]
        library = restarted.get("/api/v1/me/albums").json()["data"]
        assert recovered["cover_photo_id"] == photos[2]
        assert library["items"][0]["cover_photo_id"] == photos[2]
    reset = set_cover(client, album, None).json()["data"]
    assert reset["cover_photo_id"] == photos[0] and reset["revision"] == selected["revision"] + 1
    assert set_cover(client, album, None).json()["data"]["revision"] == reset["revision"]


def test_cover_is_account_scoped_active_and_in_same_album(cover_collection):
    app, client, _, _, owner, album, photos = cover_collection
    other_album = create(client, 2025).json()["data"]["id"]
    own_other_photos, _ = seed_photos(app, owner, other_album, 1)
    with TestClient(app) as other:
        signed_in(other, "Cover_Other")
        other_owner = other.get("/api/v1/auth/me").json()["data"]["id"]
        foreign_album = create(other, 2026).json()["data"]["id"]
        foreign_photos, _ = seed_photos(app, other_owner, foreign_album, 1)
        assert set_cover(other, album, photos[0], 2).status_code == 404
    before = client.get(f"/api/v1/albums/{album}").json()["data"]
    for photo in ("missing", foreign_photos[0], own_other_photos[0]):
        response = set_cover(client, album, photo, before["revision"])
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"
    assert set_cover(client, foreign_album, foreign_photos[0], 2).status_code == 404
    assert client.get(f"/api/v1/albums/{album}").json()["data"] == before


def test_cover_rejects_stale_revision_csrf_invalid_fields_and_large_body(cover_collection):
    _, client, _, _, _, album, photos = cover_collection
    selected = set_cover(client, album, photos[2]).json()["data"]
    response = set_cover(client, album, photos[1], selected["revision"] - 1)
    assert response.status_code == 409 and response.json()["error"]["code"] == "ALBUM_CHANGED"
    path = f"/api/v1/albums/{album}/cover"
    assert client.patch(path, json={"photo_id": None, "expected_revision": 3}).status_code == 403
    for data in (
        {"photo_id": None, "expected_revision": True},
        {"photo_id": None, "expected_revision": "3"},
        {"photo_id": 1, "expected_revision": 3},
        {"photo_id": "", "expected_revision": 3},
        {"photo_id": None, "expected_revision": 3, "owner_id": "forged"},
    ):
        assert client.patch(path, headers=csrf(client), json=data).status_code == 422
    assert client.patch(
        path, headers=csrf(client), content=b" " * (16 * 1024 + 1)
    ).status_code == 413
    assert client.get(f"/api/v1/albums/{album}").json()["data"]["cover_photo_id"] == photos[2]


def test_cover_version_is_shared_with_reordering_and_concurrent_selections(cover_collection):
    _, client, _, _, _, album, photos = cover_collection
    revision = client.get(f"/api/v1/albums/{album}").json()["data"]["revision"]
    headers = csrf(client)

    def choose(photo):
        return client.patch(
            f"/api/v1/albums/{album}/cover", headers=headers,
            json={"photo_id": photo, "expected_revision": revision},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(choose, photos[1:]))
    assert sorted(response.status_code for response in responses) == [200, 409]
    chosen = next(response.json()["data"] for response in responses if response.status_code == 200)
    assert client.post(
        f"/api/v1/albums/{album}/reorder", headers=headers,
        json={"photo_id": photos[0], "before_photo_id": None,
              "expected_album_revision": revision},
    ).status_code == 409
    reordered = client.post(
        f"/api/v1/albums/{album}/reorder", headers=headers,
        json={"photo_id": photos[0], "before_photo_id": None,
              "expected_album_revision": chosen["revision"]},
    )
    assert reordered.status_code == 200
    latest = client.get(f"/api/v1/albums/{album}").json()["data"]
    assert latest["cover_photo_id"] == chosen["cover_photo_id"]


@pytest.mark.parametrize("lifecycle", ["trash", "move"])
def test_cover_falls_back_when_selected_photo_leaves_album(cover_collection, lifecycle):
    app, client, _, _, _, album, photos = cover_collection
    selected = set_cover(client, album, photos[2]).json()["data"]
    photo = client.get(f"/api/v1/photos/{photos[2]}").json()["data"]
    if lifecycle == "trash":
        response = client.post(
            f"/api/v1/photos/{photos[2]}/trash", headers=csrf(client),
            json={"expected_photo_revision": photo["revision"],
                  "expected_album_revision": selected["revision"]},
        )
    else:
        target = create(client, 2025).json()["data"]
        response = client.post(
            f"/api/v1/photos/{photos[2]}/move", headers=csrf(client),
            json={"target_album_id": target["id"], "expected_photo_revision": photo["revision"],
                  "expected_source_revision": selected["revision"],
                  "expected_target_revision": target["revision"]},
        )
    assert response.status_code == 200
    detail = client.get(f"/api/v1/albums/{album}").json()["data"]
    assert detail["cover_photo_id"] == photos[0] and detail["photo_count"] == 2
    assert set_cover(client, album, photos[2]).status_code == 404
    # Even an invalid on-disk preference must not become an original URL.
    with app.state.auth.sessions.begin() as db:
        db.get(Album, album).preferred_cover_photo_id = "missing-photo"
    assert client.get(f"/api/v1/albums/{album}").json()["data"]["cover_photo_id"] == photos[0]


def test_cover_upgrade_preserves_old_albums_photos_and_original_bytes(cover_collection):
    _, client, _, _, _, album, photos = cover_collection
    before = client.get(f"/api/v1/albums/{album}").json()["data"]
    originals = [client.get(f"/api/v1/photos/{photo}/original").content for photo in photos]
    config = Config(Path(__file__).resolve().parents[1] / "alembic.ini")
    get_settings.cache_clear()
    command.downgrade(config, "b61e24f803a7")
    command.upgrade(config, "head")
    get_settings.cache_clear()
    assert client.get(f"/api/v1/albums/{album}").json()["data"] == before
    assert [client.get(f"/api/v1/photos/{photo}/original").content for photo in photos] == originals


@pytest.mark.parametrize("year", [None, 2026])
def test_concurrent_creation_is_atomic_and_idempotent(environment, year):
    app, client, _, _ = environment
    signed_in(client)
    headers = csrf(client)

    def attempt(_):
        return client.post(
            f"/api/v1/cities/{SHENZHEN}/albums", headers=headers, json={"year": year}
        )

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(executor.map(attempt, range(12)))
    assert [response.status_code for response in responses].count(201) == 1
    assert [response.status_code for response in responses].count(200) == 11
    assert len({response.json()["data"]["id"] for response in responses}) == 1
    with app.state.auth.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Album)) == 1


def test_two_accounts_cannot_read_each_others_albums_or_cursor(environment):
    app, first, _, _ = environment
    signed_in(first, "Album_Alpha")
    album_id = create(first, 2026).json()["data"]["id"]
    create(first, None)
    cursor = first.get(f"/api/v1/cities/{SHENZHEN}/albums?limit=1").json()["data"]["next_cursor"]
    with TestClient(app) as other:
        signed_in(other, "Album_Beta")
        assert other.get("/api/v1/me/atlas").json()["data"]["items"] == []
        assert other.get(f"/api/v1/cities/{SHENZHEN}/albums").json()["data"]["items"] == []
        assert other.get(f"/api/v1/albums/{album_id}").status_code == 404
        assert other.get("/api/v1/albums/missing").status_code == 404
        assert other.get(f"/api/v1/albums/{album_id}?owner_id=Album_Alpha").status_code == 404
        assert (
            other.get(f"/api/v1/cities/{SHENZHEN}/albums", params={"cursor": cursor}).status_code
            == 422
        )
        assert create(other, 2026, owner_id="forged").status_code == 422
        assert create(other, 2026).json()["data"]["id"] != album_id


def test_album_keyset_paging_and_inserts_before_cursor(environment):
    _, client, _, _ = environment
    signed_in(client)
    for year in (None, 2023, 2024, 2026):
        create(client, year)
    first = client.get(f"/api/v1/cities/{SHENZHEN}/albums?limit=2").json()["data"]
    assert [a["year"] for a in first["items"]] == [2026, 2024]
    create(client, 2025)  # Earlier page gains an item; remaining page must not duplicate.
    second = client.get(
        f"/api/v1/cities/{SHENZHEN}/albums", params={"limit": 2, "cursor": first["next_cursor"]}
    ).json()["data"]
    assert [a["year"] for a in second["items"]] == [2023, None]
    assert second["next_cursor"] is None
    assert (
        client.get(
            f"/api/v1/cities/{GUANGZHOU}/albums", params={"cursor": first["next_cursor"]}
        ).status_code
        == 422
    )


@pytest.mark.parametrize("year", [0, -1, 10000, True, False, 2026.0, 2026.5, "2026", "", [], {}])
def test_year_is_strict_integer_or_null(environment, year):
    _, client, _, _ = environment
    signed_in(client)
    assert create(client, year).status_code == 422
    assert client.get("/api/v1/me/atlas").json()["data"]["album_count"] == 0


def test_required_year_csrf_and_body_limit(environment):
    _, client, _, _ = environment
    signed_in(client)
    path = f"/api/v1/cities/{SHENZHEN}/albums"
    assert client.post(path, headers=csrf(client), json={}).status_code == 422
    assert client.post(path, json={"year": 2026}).status_code == 403
    assert (
        client.post(
            path, headers={**csrf(client), "Origin": "https://foreign.invalid"}, json={"year": 2026}
        ).status_code
        == 403
    )
    assert client.post(path, headers=csrf(client), content=b"x" * 16385).status_code == 413


@pytest.mark.parametrize(
    "path", ["/cities", "/me/atlas", f"/cities/{SHENZHEN}/albums", "/albums/missing"]
)
def test_private_endpoints_require_authenticated_session(environment, path):
    _, client, _, _ = environment
    assert client.get("/api/v1" + path).status_code == 401
    csrf(client)
    assert client.get("/api/v1" + path).status_code == 401
    assert create(client, 2026).status_code == 401


def test_retired_and_pending_cities_keep_owned_history_but_block_new_albums(environment):
    app, client, _, _ = environment
    signed_in(client)
    album_id = create(client, 2026).json()["data"]["id"]
    with app.state.auth.sessions.begin() as db:
        db.execute(update(City).where(City.id == SHENZHEN).values(is_active=0))
        db.execute(update(City).where(City.id == GUANGZHOU).values(mapping_status="pending"))
    assert client.get("/api/v1/cities?q=深圳").json()["data"]["items"] == []
    assert client.get("/api/v1/cities?q=广州").json()["data"]["items"] == []
    assert client.get("/api/v1/cities?q=贺州").json()["data"]["items"][0]["name"] == "贺州市"
    assert create(client, 2027).status_code == 409
    assert create(client, 2026, GUANGZHOU).status_code == 409
    assert client.get(f"/api/v1/albums/{album_id}").status_code == 200
    data = client.get(f"/api/v1/cities/{SHENZHEN}/albums").json()["data"]
    assert data["city"]["can_create"] is False and len(data["items"]) == 1
    assert client.get(f"/api/v1/cities/{GUANGZHOU}/albums").status_code == 404
    assert client.get("/api/v1/me/atlas").json()["data"]["album_count"] == 1


def test_missing_city_and_paging_validation(environment):
    _, client, _, _ = environment
    signed_in(client)
    assert create(client, 2026, "missing").status_code == 404
    assert client.get("/api/v1/cities/missing/albums").status_code == 404
    for query in ("limit=0", "limit=101", "limit=no", "cursor=invalid", "q=" + "x" * 81):
        assert client.get("/api/v1/cities?" + query).status_code == 422
    response = client.get("/api/v1/cities")
    assert response.headers["Cache-Control"] == "private, no-store"


def test_albums_survive_app_restart_and_logout_blocks_old_cookie(environment):
    app, client, settings, now = environment
    signed_in(client)
    album_id = create(client, None).json()["data"]["id"]
    cookie = client.cookies[COOKIE_NAME]
    with TestClient(create_app(settings)) as restarted:
        restarted.app.state.auth.clock = lambda: now[0]
        restarted.cookies.set(COOKIE_NAME, cookie, domain="testserver.local", path="/")
        assert restarted.get(f"/api/v1/albums/{album_id}").json()["data"]["year"] is None
        assert create(restarted, None).json()["data"]["id"] == album_id
        assert restarted.post("/api/v1/auth/logout", headers=csrf(restarted)).status_code == 204
    assert client.get(f"/api/v1/albums/{album_id}").status_code == 401


def test_storage_failure_is_not_success(environment, monkeypatch):
    app, client, _, _ = environment
    signed_in(client)
    headers = csrf(client)

    def fail():
        raise OperationalError("sensitive SQL", {}, Exception("private filesystem"))

    monkeypatch.setattr(app.state.auth.sessions, "begin", fail)
    result = client.post(f"/api/v1/cities/{SHENZHEN}/albums", headers=headers, json={"year": 2026})
    assert result.status_code == 503
    assert "sensitive" not in result.text and "filesystem" not in result.text


def test_counts_and_cover_exclude_other_accounts_trash_and_staging(environment):
    app, client, _, _ = environment
    signed_in(client)
    owner = client.get("/api/v1/auth/me").json()["data"]["id"]
    album_id = create(client, 2026).json()["data"]["id"]
    create(client, None)  # Empty albums still count.
    first_photo = None
    with app.state.auth.sessions.begin() as db:
        batch_id = str(uuid4())
        db.add(
            ImportBatch(
                id=batch_id,
                owner_id=owner,
                album_id=album_id,
                request_key="fixture",
                request_hash="a" * 64,
                expected_count=4,
                state="open",
                created_at=1,
                expires_at=9999,
            )
        )
        db.flush()
        for index, state in enumerate(("active", "active", "trashed", "staged")):
            item_id, photo_id = str(uuid4()), str(uuid4())
            db.add(
                UploadItem(
                    id=item_id,
                    owner_id=owner,
                    batch_id=batch_id,
                    item_index=index,
                    original_filename="synthetic.png",
                    expected_bytes=1,
                    expected_sha256="a" * 64,
                    storage_key=item_id,
                    reserved_photo_id=photo_id,
                    state="staged",
                    actual_bytes=1,
                    sha256="a" * 64,
                    mime_type="image/png",
                    width=1,
                    height=1,
                    created_at=1,
                    updated_at=1,
                )
            )
            db.flush()
            if state == "staged":
                continue
            position = 1 - index if state == "active" else None
            if position == 0:
                first_photo = photo_id
            db.add(
                Photo(
                    id=photo_id,
                    owner_id=owner,
                    album_id=album_id,
                    upload_item_id=item_id,
                    storage_key=photo_id,
                    original_filename="synthetic.png",
                    byte_size=1,
                    sha256="a" * 64,
                    mime_type="image/png",
                    width=1,
                    height=1,
                    position=position,
                    state=state,
                    created_at=1,
                    updated_at=1,
                    deleted_at=1 if state == "trashed" else None,
                    purge_after=2592000001 if state == "trashed" else None,
                )
            )
    detail = client.get(f"/api/v1/albums/{album_id}").json()["data"]
    assert detail["photo_count"] == 2 and detail["cover_photo_id"] == first_photo
    assert detail["original_url"] == f"/api/v1/photos/{first_photo}/original"
    atlas = client.get("/api/v1/me/atlas").json()["data"]
    assert atlas["album_count"] == 2 and atlas["photo_count"] == 2
    assert atlas["items"][0]["lit"] is True
    client.post("/api/v1/auth/logout", headers=csrf(client))
    signed_in(client, "Other_Album_Owner")
    create(client, 2026)
    atlas = client.get("/api/v1/me/atlas").json()["data"]
    assert atlas["album_count"] == 1 and atlas["photo_count"] == 0
    assert atlas["items"][0]["lit"] is False
