"""真实停止并重启 Uvicorn，使用临时磁盘数据库核对会话与账号。"""

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
        with running_server(port, environment):
            assert client.get("/api/v1/auth/me").json()["data"]["id"] == user_id
            old_cookie = client.cookies.get("city_memories_session")
            assert client.post("/api/v1/auth/logout", headers=headers()).status_code == 204
        with running_server(port, environment):
            client.cookies.set("city_memories_session", old_cookie, domain="127.0.0.1", path="/")
            assert client.get("/api/v1/auth/me").status_code == 401
            assert (
                client.post("/api/v1/auth/login", headers=headers(), json=credentials).status_code
                == 200
            )
