"""City albums aggregate every owned year before pagination; only synthetic data."""

import base64
import json
from uuid import uuid4

from fastapi.testclient import TestClient
from photo_fixtures import seed_photos
from sqlalchemy import select
from starlette.requests import Request
from test_albums import GUANGZHOU, SHENZHEN, create, set_cover, signed_in
from test_auth import csrf
from test_auth import environment as environment

from city_memories.albums import encode_cursor
from city_memories.models import Album, City

PATH = "/api/v1/me/city-albums"


def owner_id(client):
    return client.get("/api/v1/auth/me").json()["data"]["id"]


def collect(client, **params):
    page = client.get(PATH, params=params)
    assert page.status_code == 200
    data = page.json()["data"]
    items = data["items"]
    while data["next_cursor"]:
        response = client.get(PATH, params={**params, "cursor": data["next_cursor"]})
        assert response.status_code == 200
        data = response.json()["data"]
        items += data["items"]
    return items


def test_city_aggregation_keeps_all_years_and_empty_albums(environment):
    _, client, _, _ = environment
    assert client.get(PATH).status_code == 401
    signed_in(client)
    assert client.get(PATH).json()["data"] == {"items": [], "next_cursor": None}
    identifiers = [create(client, year).json()["data"]["id"] for year in range(2000, 2028)]
    create(client, None)
    create(client, None, GUANGZHOU)
    response = client.get(PATH)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    data = response.json()["data"]
    assert data["next_cursor"] is None and len(data["items"]) == 2
    city, unmarked = data["items"]
    assert city["city"]["id"] == SHENZHEN
    assert {key: city[key] for key in (
        "album_count", "photo_count", "latest_year", "has_unmarked", "cover_photo_id",
        "original_url",
    )} == {
        "album_count": 29, "photo_count": 0, "latest_year": 2027, "has_unmarked": True,
        "cover_photo_id": None, "original_url": None,
    }
    assert unmarked["city"]["id"] == GUANGZHOU
    assert unmarked["latest_year"] is None and unmarked["album_count"] == 1
    # Filtering selects cities, while their complete year totals stay intact.
    selected = collect(client, year="2026")
    assert len(selected) == 1 and selected[0] == city
    assert collect(client, year="unmarked") == data["items"]
    assert len(collect(client, q=" 广东 ")) == 2
    # Existing year-level routes and identifiers retain their original meaning.
    first = client.get(f"/api/v1/cities/{SHENZHEN}/albums").json()["data"]
    assert len(first["items"]) == 24 and first["next_cursor"]
    assert client.get(f"/api/v1/albums/{identifiers[0]}").json()["data"]["year"] == 2000
    assert not any(key in response.text for key in ("owner_id", "storage_key", "updated_at"))


def test_city_pages_are_unique_and_filtered_before_paging_for_both_orders(environment):
    app, client, _, now = environment
    signed_in(client)
    owner = owner_id(client)
    records = []
    with app.state.auth.sessions.begin() as db:
        cities = db.scalars(
            select(City).where(City.is_active == 1).order_by(City.id).limit(32)
        ).all()
        for index, city in enumerate(cities):
            city.parent_name = "合成甲省" if index < 28 else "合成乙省"
            changed = now[0] + index % 5
            records.append((city.id, changed))
            for year in (2026, 2024, None):
                db.add(Album(
                    id=str(uuid4()), owner_id=owner, city_id=city.id, year=year,
                    revision=1, created_at=now[0], updated_at=changed,
                ))
    first = client.get(PATH).json()["data"]
    assert len(first["items"]) == 24 and first["next_cursor"]
    assert len(collect(client)) == 32
    for sort in ("year", "recent"):
        expected = sorted(records[:28], key=lambda row: (-(row[1] if sort == "recent" else 2026),
                                                        row[0]))
        items = collect(client, sort=sort, q="合成甲省", year="2024", limit=7)
        assert [item["city"]["id"] for item in items] == [row[0] for row in expected]
        assert len({item["city"]["id"] for item in items}) == 28
        assert all(item["album_count"] == 3 and item["latest_year"] == 2026 for item in items)
        assert all(item["has_unmarked"] and item["photo_count"] == 0 for item in items)
    assert collect(client, q="不存在") == []
    for query in ("%", "_", "' OR 1=1 --"):
        assert collect(client, q=query) == []
    # Newer insertions ahead of a saved position do not repeat cities on the next page.
    cursor = first["next_cursor"]
    create(client, 9999, records[0][0])
    following = client.get(PATH, params={"cursor": cursor}).json()["data"]["items"]
    assert not {row["city"]["id"] for row in first["items"]} & {
        row["city"]["id"] for row in following
    }


def test_city_cover_uses_newest_nonempty_year_and_honors_preferred_cover(environment):
    app, client, _, _ = environment
    signed_in(client)
    owner = owner_id(client)
    create(client, 2027)  # A newer empty year must not hide an older year's cover.
    current = create(client, 2026).json()["data"]["id"]
    old = create(client, 2025).json()["data"]["id"]
    unmarked = create(client, None).json()["data"]["id"]
    photos, _ = seed_photos(app, owner, current, 3)
    older, _ = seed_photos(app, owner, old, 1)
    unspecified, _ = seed_photos(app, owner, unmarked, 1)
    assert set_cover(client, current, photos[2]).status_code == 200
    city = collect(client)[0]
    assert city["cover_photo_id"] == photos[2] and city["photo_count"] == 5
    assert city["original_url"] == f"/api/v1/photos/{photos[2]}/original"
    assert collect(client, year="2025")[0] == city
    with app.state.auth.sessions.begin() as db:
        # An on-disk stale preference is ignored in both the year and city view.
        db.get(Album, current).preferred_cover_photo_id = older[0]
    assert collect(client)[0]["cover_photo_id"] == photos[0]
    for photo_id in photos:
        photo = client.get(f"/api/v1/photos/{photo_id}").json()["data"]
        revision = client.get(f"/api/v1/albums/{current}").json()["data"]["revision"]
        assert client.post(f"/api/v1/photos/{photo_id}/trash", headers=csrf(client), json={
            "expected_photo_revision": photo["revision"], "expected_album_revision": revision,
        }).status_code == 200
    remaining = collect(client)[0]
    assert remaining["cover_photo_id"] == older[0] and remaining["photo_count"] == 2
    assert remaining["album_count"] == 4 and remaining["latest_year"] == 2027
    photo = client.get(f"/api/v1/photos/{older[0]}").json()["data"]
    revision = client.get(f"/api/v1/albums/{old}").json()["data"]["revision"]
    assert client.post(f"/api/v1/photos/{older[0]}/trash", headers=csrf(client), json={
        "expected_photo_revision": photo["revision"], "expected_album_revision": revision,
    }).status_code == 200
    assert collect(client)[0]["cover_photo_id"] == unspecified[0]
    assert collect(client)[0]["photo_count"] == 1


def test_city_cover_and_counts_follow_moved_photos(environment):
    app, client, _, _ = environment
    signed_in(client)
    owner = owner_id(client)
    source = create(client, 2026).json()["data"]["id"]
    target = create(client, 2025, GUANGZHOU).json()["data"]["id"]
    photos, _ = seed_photos(app, owner, source, 2)
    assert set_cover(client, source, photos[1]).status_code == 200
    photo = client.get(f"/api/v1/photos/{photos[1]}").json()["data"]
    source_revision = client.get(f"/api/v1/albums/{source}").json()["data"]["revision"]
    target_revision = client.get(f"/api/v1/albums/{target}").json()["data"]["revision"]
    assert client.post(f"/api/v1/photos/{photos[1]}/move", headers=csrf(client), json={
        "target_album_id": target, "expected_photo_revision": photo["revision"],
        "expected_source_revision": source_revision, "expected_target_revision": target_revision,
    }).status_code == 200
    items = {item["city"]["id"]: item for item in collect(client)}
    assert items[SHENZHEN]["cover_photo_id"] == photos[0]
    assert items[GUANGZHOU]["cover_photo_id"] == photos[1]
    assert items[SHENZHEN]["photo_count"] == items[GUANGZHOU]["photo_count"] == 1


def test_city_library_keeps_account_and_retired_history_isolated(environment):
    app, client, _, _ = environment
    signed_in(client)
    album = create(client, 2026).json()["data"]["id"]
    own, _ = seed_photos(app, owner_id(client), album, 1)
    with TestClient(app) as other:
        signed_in(other, "City_Album_Other")
        assert collect(other) == []
        foreign = create(other, 2028).json()["data"]["id"]
        foreign_photos, _ = seed_photos(app, owner_id(other), foreign, 2)
        create(other, 2025, GUANGZHOU)
        with app.state.auth.sessions.begin() as db:
            # A corrupted preference must not leak another owner's original URL.
            db.get(Album, album).preferred_cover_photo_id = foreign_photos[0]
            city = db.get(City, SHENZHEN)
            city.is_active = 0
            city.mapping_status = "pending"
        mine = collect(client)
        assert len(mine) == 1 and mine[0]["album_count"] == 1
        assert mine[0]["photo_count"] == 1 and mine[0]["cover_photo_id"] == own[0]
        assert mine[0]["latest_year"] == 2026 and not mine[0]["city"]["can_create"]
        theirs = collect(other)
        assert len(theirs) == 2 and theirs[0]["photo_count"] == 2
        assert theirs[0]["cover_photo_id"] == foreign_photos[0]
        assert collect(client, year="2028") == []


def test_city_cursor_binds_owner_filters_order_and_resource_and_validates_keys(environment):
    app, client, _, _ = environment
    signed_in(client)
    for city in (SHENZHEN, GUANGZHOU):
        for year in (2026, None):
            create(client, year, city)
    params = {"q": " 广东 ", "year": "2026", "limit": 1}
    cursor = client.get(PATH, params=params).json()["data"]["next_cursor"]
    assert cursor
    second = client.get(PATH, params={**params, "q": "广东", "cursor": cursor})
    assert second.status_code == 200 and second.json()["data"]["next_cursor"] is None
    for changed in (
        {}, {"q": "广东"}, {"year": "2026"}, {"q": "深圳", "year": "2026"},
        {"q": "广东", "year": "unmarked"}, {"q": "广东", "year": "2025"},
        {"q": "广东", "year": "2026", "sort": "recent"},
    ):
        response = client.get(PATH, params={**changed, "cursor": cursor})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_CURSOR"
    legacy = client.get("/api/v1/me/albums?limit=1").json()["data"]["next_cursor"]
    assert client.get(PATH, params={"cursor": legacy}).status_code == 422
    assert client.get("/api/v1/me/albums", params={"cursor": cursor}).status_code == 422
    assert client.get(PATH, params={**params, "cursor": cursor + "x"}).status_code == 422
    with TestClient(app) as other:
        signed_in(other, "City_Cursor_Other")
        assert other.get(PATH, params={**params, "cursor": cursor}).status_code == 422
    scope = json.loads(base64.urlsafe_b64decode(cursor.split(".")[0]))[0]
    request = Request({"type": "http", "app": app})
    for keys in (
        [-1, SHENZHEN], [True, SHENZHEN], [1.5, SHENZHEN], ["1", SHENZHEN],
        [10000, SHENZHEN], [1, ""], [1, "x" * 37], [1, SHENZHEN, "extra"],
    ):
        invalid = encode_cursor(request, scope, keys)
        assert client.get(PATH, params={**params, "cursor": invalid}).status_code == 422
    recent = client.get(PATH, params={"sort": "recent", "limit": 1}).json()["data"]
    recent_scope = json.loads(base64.urlsafe_b64decode(recent["next_cursor"].split(".")[0]))[0]
    for key in (-1, True, 1.5, "1", 2**63):
        invalid = encode_cursor(request, recent_scope, [key, SHENZHEN])
        response = client.get(PATH, params={"sort": "recent", "cursor": invalid})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_CURSOR"
    for invalid in (
        {"limit": 0}, {"limit": 101}, {"sort": "unknown"}, {"q": "城" * 81},
        {"year": ""}, {"year": "0"}, {"year": "10000"}, {"year": "2026.0"},
        {"year": "２０２６"}, {"year": "unmarked "},
    ):
        response = client.get(PATH, params=invalid)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"
