"""真实停止并重启 Uvicorn，使用临时磁盘数据库核对会话与账号。"""

import hashlib
import io
import os
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import httpx
from alembic import command
from alembic.config import Config
from PIL import Image

from city_memories.config import get_settings


@contextmanager
def running_server(port, environment):
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "city_memories.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--no-proxy-headers",
            "--no-access-log",
        ],
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            assert process.poll() is None, "Uvicorn exited before becoming ready"
            try:
                if (
                    httpx.get(f"http://127.0.0.1:{port}/api/v1/health", timeout=1).status_code
                    == 200
                ):
                    break
            except httpx.TransportError:
                pass
            time.sleep(0.05)
        else:
            raise AssertionError("Uvicorn did not become ready")
        yield
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def test_real_process_restart_preserves_login_and_revocation(tmp_path, monkeypatch):
    monkeypatch.setenv("CITY_MEMORIES_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    command.upgrade(Config(Path(__file__).resolve().parents[1] / "alembic.ini"), "head")
    get_settings.cache_clear()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    environment = os.environ | {"CITY_MEMORIES_ALLOWED_ORIGINS": f'["{origin}"]'}
    credentials = {"username": "Restart_Traveler", "password": "A temporary restart test password"}
    with httpx.Client(base_url=origin) as client:

        def headers():
            result = client.get("/api/v1/auth/csrf")
            return {"Origin": origin, "X-CSRF-Token": result.json()["data"]["csrf_token"]}

        with running_server(port, environment):
            response = client.post(
                "/api/v1/auth/register",
                headers=headers(),
                json={
                    **credentials,
                    "password_confirm": credentials["password"],
                },
            )
            assert response.status_code == 201
            user_id = response.json()["data"]["id"]
            assert (
                client.post("/api/v1/auth/login", headers=headers(), json=credentials).status_code
                == 200
            )
            city_id = client.get("/api/v1/cities", params={"q": "深圳"}).json()["data"]["items"][0][
                "id"
            ]
            album_response = client.post(
                f"/api/v1/cities/{city_id}/albums", headers=headers(), json={"year": 2026}
            )
            assert album_response.status_code == 201
            album_id = album_response.json()["data"]["id"]
            synthetic = io.BytesIO()
            Image.new("RGB", (24, 18), "teal").save(synthetic, format="PNG")
            image_bytes = synthetic.getvalue()
            source_path = tmp_path / "synthetic-source.png"
            source_path.write_bytes(image_bytes)
            batch = client.post(
                f"/api/v1/albums/{album_id}/imports",
                headers={**headers(), "Idempotency-Key": "restart-original"},
                json={
                    "items": [
                        {
                            "original_filename": source_path.name,
                            "byte_size": len(image_bytes),
                            "sha256": hashlib.sha256(image_bytes).hexdigest(),
                        }
                    ]
                },
            ).json()["data"]
            assert (
                client.put(
                    f"/api/v1/imports/{batch['id']}/items/{batch['items'][0]['id']}/content",
                    headers=headers(),
                    files={"file": (source_path.name, image_bytes, "image/png")},
                ).status_code
                == 200
            )
            committed = client.post(
                f"/api/v1/imports/{batch['id']}/commit",
                headers=headers(),
                json={"expected_album_revision": 1},
            )
            assert committed.status_code == 200
            photo_id = committed.json()["data"]["photo_ids"][0]
            source_path.rename(tmp_path / "synthetic-source-moved.png")
        with running_server(port, environment):
            assert client.get("/api/v1/auth/me").json()["data"]["id"] == user_id
            assert client.get(f"/api/v1/albums/{album_id}").json()["data"]["year"] == 2026
            listed = client.get(f"/api/v1/albums/{album_id}/photos").json()["data"]
            assert [photo["id"] for photo in listed["items"]] == [photo_id]
            detail = client.get(f"/api/v1/photos/{photo_id}").json()["data"]
            assert detail["ordinal"] == 1 and detail["next_photo_id"] is None
            assert client.get(f"/api/v1/photos/{photo_id}/original").content == image_bytes
            duplicate = client.post(
                f"/api/v1/cities/{city_id}/albums", headers=headers(), json={"year": 2026}
            )
            assert duplicate.status_code == 200 and duplicate.json()["data"]["id"] == album_id
            old_cookie = client.cookies.get("city_memories_session")
            assert client.post("/api/v1/auth/logout", headers=headers()).status_code == 204
        with running_server(port, environment):
            client.cookies.set("city_memories_session", old_cookie, domain="127.0.0.1", path="/")
            assert client.get("/api/v1/auth/me").status_code == 401
            assert client.get(f"/api/v1/albums/{album_id}").status_code == 401
            assert client.get(f"/api/v1/photos/{photo_id}/original").status_code == 401
            assert client.get(f"/api/v1/albums/{album_id}/photos").status_code == 401
            assert client.get(f"/api/v1/photos/{photo_id}").status_code == 401
            assert (
                client.post("/api/v1/auth/login", headers=headers(), json=credentials).status_code
                == 200
            )
