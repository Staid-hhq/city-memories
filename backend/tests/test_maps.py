from uuid import UUID

import pytest
from pydantic import SecretStr
from sqlalchemy import select, update
from test_albums import SHENZHEN, create, signed_in
from test_auth import environment as environment

from city_memories.maps import CATALOG, seed_reviewed_cities
from city_memories.models import City


def test_map_endpoints_require_login_and_never_cache(environment):
    _, client, _, _ = environment
    for path in ("/map/config", "/map/cities"):
        response = client.get("/api/v1" + path)
        assert response.status_code == 401
        assert response.headers["cache-control"] == "private, no-store"
        assert "key" not in response.json().get("data", {})


def test_map_configuration_disabled_without_credentials(environment):
    _, client, _, _ = environment
    signed_in(client)
    data = client.get("/api/v1/map/config").json()["data"]
    assert data["enabled"] is False and data["key"] is None


def test_map_key_only_authenticated_same_origin_browser_configuration(environment):
    _, client, settings, _ = environment
    settings.map_key = SecretStr("0" * 32)
    settings.map_review_number = "SYNTHETIC TEST ONLY"
    settings.map_review_date = "2026-10-04"
    signed_in(client)
    response = client.get("/api/v1/map/config")
    assert response.json()["data"]["key"] == "0" * 32
    assert response.headers["cache-control"] == "private, no-store"
    for headers in ({"Origin": "https://example.invalid"}, {"Sec-Fetch-Site": "cross-site"}):
        denied = client.get("/api/v1/map/config", headers=headers)
        assert denied.status_code == 403 and "0" * 32 not in denied.text


@pytest.mark.parametrize("contents", ["unrelated=text", "TIANDITU_KEY=bad", "x" * 8193])
def test_invalid_local_map_configuration_is_redacted(environment, tmp_path, contents):
    _, client, settings, _ = environment
    # Synthetic configuration, never the user's real file.
    target = tmp_path / "synthetic.env"
    target.write_text(contents, encoding="utf-8")
    settings.map_key_file = target
    settings.map_review_number = "SYNTHETIC TEST ONLY"
    settings.map_review_date = "2026-10-04"
    signed_in(client)
    response = client.get("/api/v1/map/config")
    assert response.status_code == 200 and response.json()["data"]["enabled"] is False
    assert str(target) not in response.text and contents not in response.text


def test_reviewed_catalog_excludes_pending_units_and_preserves_original_ids(environment):
    app, client, _, _ = environment
    signed_in(client)
    data = client.get("/api/v1/map/cities").json()["data"]
    assert len(data) == len({row["provider_code"] for row in data}) == 391
    assert next(row for row in data if row["name"] == "深圳市")["id"] == SHENZHEN
    assert all(UUID(row["id"]).version == 4 for row in data)
    assert not any("center" in row or "geometry" in row for row in data)
    assert len([r for r in data if r["unit_kind"] == "taiwan-destination"]) == 20
    with app.state.auth.sessions() as db:
        pending = db.scalar(select(City).where(City.provider_code == "156659013"))
        assert pending.mapping_status == "pending"
        assert create(client, 2026, pending.id).status_code == 409
    assert client.get("/api/v1/cities?q=草湖").json()["data"]["items"] == []


def test_seeding_does_not_reactivate_or_rename_existing_city(environment):
    app, client, _, _ = environment
    signed_in(client)
    album = create(client, 2026).json()["data"]
    with app.state.auth.sessions.begin() as db:
        db.execute(update(City).where(City.id == SHENZHEN).values(
            mapping_status="pending", is_active=0, name="人工待核对名称"))
    seed_reviewed_cities(app.state.engine)
    assert not any(row["id"] == SHENZHEN for row in client.get("/api/v1/map/cities").json()["data"])
    current = client.get(f"/api/v1/albums/{album['id']}").json()["data"]
    assert current["city"]["name"] == "人工待核对名称"
    assert create(client, 2027).status_code == 409


def test_special_city_kinds_can_create_owned_albums_without_changing_mapping(environment):
    _, client, _, _ = environment
    signed_in(client)
    for kind in ("municipality", "special-region", "direct-admin-unit", "taiwan-destination"):
        row = next(r for r in CATALOG["cities"]
                   if r["unit_kind"] == kind and r["mapping_status"] == "verified")
        result = create(client, 2026, row["id"])
        assert result.status_code == 201
        assert result.json()["data"]["city"]["unit_kind"] == kind
