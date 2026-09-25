"""T06 queue recovery is owner-scoped; data never becomes an authorization key."""

from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from test_albums import signed_in
from test_auth import csrf, login
from test_auth import environment as environment
from test_imports import album_environment as album_environment
from test_imports import commit, metadata, picture_bytes, start, upload

from city_memories.imports import DAY
from city_memories.models import UploadItem


def test_queue_recovers_all_states_in_confirmed_order_and_hides_private_fields(album_environment):
    app, client, _, _, album = album_environment
    queue = str(uuid4())
    content = picture_bytes()
    second = start(client, album["id"], content, f"{queue}_000001").json()["data"]
    first = start(client, album["id"], content, f"{queue}_000000").json()["data"]
    assert upload(client, first, content).status_code == 200
    receipt = commit(client, first).json()["data"]
    assert upload(client, second, b"wrong size").status_code >= 400
    response = client.get(f"/api/v1/imports/queue/{queue}")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    data = response.json()["data"]
    assert data["next_index"] is None
    assert [item["queue_index"] for item in data["items"]] == [0, 1]
    assert data["items"][0]["result"] == receipt
    assert data["items"][1]["items"][0]["state"] == "failed"
    assert all(item["city_id"] == album["city"]["id"] for item in data["items"])
    assert all(item["year"] == album["year"] for item in data["items"])
    for forbidden in ("storage_key", "sha256", "request_key", "attempt_token", "owner_id"):
        assert forbidden not in response.text
    with TestClient(app) as other:
        signed_in(other, "QueueOther")
        assert other.get(f"/api/v1/imports/queue/{queue}").json()["data"]["items"] == []
        assert other.get(f"/api/v1/imports/{first['id']}").status_code == 404
        assert (
            other.delete(f"/api/v1/imports/{first['id']}", headers=csrf(other)).status_code == 404
        )
    client.post("/api/v1/auth/logout", headers=csrf(client))
    assert client.get(f"/api/v1/imports/queue/{queue}").status_code == 401


def test_queue_pagination_key_filter_and_validation(album_environment):
    _, client, _, _, album = album_environment
    queue = str(uuid4())
    content = picture_bytes()
    # Lexicographic fixed-width keys preserve confirmed batch order.
    for index in range(27):
        assert start(client, album["id"], content, f"{queue}_{index:06d}").status_code == 201
    for suffix in ("abcdef", "00002_", "0000010", "0000"):
        assert start(client, album["id"], content, f"{queue}_{suffix}").status_code == 201
    start(client, album["id"], content, f"{uuid4()}_000000")
    first = client.get(f"/api/v1/imports/queue/{queue}").json()["data"]
    assert len(first["items"]) == 25 and first["next_index"] == 24
    second = client.get(f"/api/v1/imports/queue/{queue}?after=24").json()["data"]
    assert [item["queue_index"] for item in second["items"]] == [25, 26]
    assert second["next_index"] is None
    assert client.get(f"/api/v1/imports/queue/{queue}?after=999999").json()["data"]["items"] == []
    assert client.get(f"/api/v1/imports/queue/{queue}?after=-2").status_code == 422
    assert client.get("/api/v1/imports/queue/not-a-uuid").status_code == 422


def test_expired_queue_can_be_seen_and_scoped_cleanup_keeps_saved_originals(album_environment):
    app, client, settings, now, album = album_environment
    queue = str(uuid4())
    content = picture_bytes()
    saved = start(client, album["id"], content, f"{queue}_000000").json()["data"]
    upload(client, saved, content)
    photo = commit(client, saved).json()["data"]["photo_ids"][0]
    staged = start(client, album["id"], content, f"{queue}_000001").json()["data"]
    upload(client, staged, content)
    now[0] += DAY
    # Renew the test account session after the simulated passage of time.
    assert login(client, "Album_Traveler").status_code == 200
    batches = client.get(f"/api/v1/imports/queue/{queue}").json()["data"]["items"]
    assert [batch["state"] for batch in batches] == ["committed", "expired"]
    assert client.get(f"/api/v1/imports/{staged['id']}").status_code == 410
    assert commit(client, staged).status_code == 410
    assert client.delete(f"/api/v1/imports/{staged['id']}", headers=csrf(client)).status_code == 204
    assert not list(settings.staging_dir.iterdir())
    assert len(list(settings.originals_dir.iterdir())) == 1
    assert client.get(f"/api/v1/photos/{photo}/original").content == content
    with app.state.auth.sessions() as db:
        item = db.scalar(select(UploadItem).where(UploadItem.batch_id == staged["id"]))
        assert item.state == "discarded"
        assert item.attempt_token is None and item.lease_until is None


def test_batch_metadata_boundary_400_and_401(album_environment):
    _, client, _, _, album = album_environment
    content = picture_bytes()
    rows = [metadata(content, f"24-{index + 1}.png") for index in range(401)]
    url = f"/api/v1/albums/{album['id']}/imports"
    headers = {**csrf(client), "Idempotency-Key": str(uuid4())}
    assert client.post(url, headers=headers, json={"items": rows}).status_code == 422
    result = client.post(url, headers=headers, json={"items": rows[:400]})
    assert result.status_code == 201
    assert [item["item_index"] for item in result.json()["data"]["items"]] == list(range(400))
    assert client.post(url, headers=headers, json={"items": rows[:400]}).status_code == 200
