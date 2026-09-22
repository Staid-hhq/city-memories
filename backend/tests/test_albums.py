from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update
from sqlalchemy.exc import OperationalError
from test_auth import csrf, login, register
from test_auth import environment as environment

from city_memories.auth import COOKIE_NAME
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
    assert {city["name"] for city in all_cities} == {"深圳市", "广州市", "贺州市"}
    assert all(city["can_create"] and city["unit_kind"] == "prefecture" for city in all_cities)
    first = client.get("/api/v1/cities?limit=1").json()["data"]
    collected = first["items"]
    while first["next_cursor"]:
        first = client.get(
            "/api/v1/cities", params={"limit": 1, "cursor": first["next_cursor"]}
        ).json()["data"]
        collected += first["items"]
    assert collected == all_cities
    assert len(client.get("/api/v1/cities?q=广东").json()["data"]["items"]) == 2
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
    assert [city["name"] for city in client.get("/api/v1/cities").json()["data"]["items"]] == [
        "贺州市"
    ]
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
