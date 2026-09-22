import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError

from city_memories.auth import ANONYMOUS_TTL, COOKIE_NAME, LOGIN_TTL, LOGIN_WINDOW
from city_memories.config import Settings, get_settings
from city_memories.main import create_app
from city_memories.models import AuthRateLimit, LoginSession, User

PASSWORD = "  测试专用的旅行短句 password 2026  "
WRONG_PASSWORD = "This is a wrong test password"
ORIGIN = "http://testserver"


@pytest.fixture
def environment(tmp_path, monkeypatch):
    monkeypatch.setenv("CITY_MEMORIES_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    command.upgrade(Config(Path(__file__).resolve().parents[1] / "alembic.ini"), "head")
    get_settings.cache_clear()
    settings = Settings(
        data_dir=tmp_path,
        allowed_origins=[ORIGIN],
        auth_secret=None,
        cookie_secure=False,
        _env_file=None,
    )
    app = create_app(settings)
    now = [1_800_000_000_000]
    with TestClient(app) as client:
        app.state.auth.clock = lambda: now[0]
        yield app, client, settings, now
    get_settings.cache_clear()


def csrf(client):
    response = client.get("/api/v1/auth/csrf")
    assert response.status_code == 200
    return {"Origin": ORIGIN, "X-CSRF-Token": response.json()["data"]["csrf_token"]}


def register(client, name="Traveler", password=PASSWORD):
    return client.post(
        "/api/v1/auth/register",
        headers=csrf(client),
        json={
            "username": name,
            "password": password,
            "password_confirm": password,
        },
    )


def login(client, name="Traveler", password=PASSWORD):
    return client.post(
        "/api/v1/auth/login",
        headers=csrf(client),
        json={
            "username": name,
            "password": password,
        },
    )


def test_registration_hash_and_private_response(environment):
    app, client, _, _ = environment
    response = register(client)
    assert response.status_code == 201
    assert set(response.json()["data"]) == {"id", "username", "created_at"}
    assert response.json()["data"]["created_at"].endswith("Z")
    assert client.get("/api/v1/auth/me").status_code == 401
    assert response.headers["cache-control"] == "private, no-store"
    with app.state.auth.sessions() as db:
        user = db.scalar(select(User))
        assert user.password_hash.startswith("$argon2id$")
        assert app.state.auth.passwords.verify(PASSWORD, user.password_hash)
        assert not app.state.auth.passwords.verify(PASSWORD.strip(), user.password_hash)
        assert PASSWORD not in user.password_hash


def test_duplicate_username_never_overwrites(environment):
    app, client, _, _ = environment
    original = register(client).json()["data"]
    duplicate = register(client, "tRAVELER", WRONG_PASSWORD)
    assert duplicate.status_code == 409
    with app.state.auth.sessions() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 1
    assert login(client).json()["data"]["user"]["id"] == original["id"]
    assert login(client, password=WRONG_PASSWORD).status_code == 401


def test_wrong_and_unknown_passwords_have_same_error(environment):
    _, client, _, _ = environment
    register(client)
    wrong = login(client, password=WRONG_PASSWORD)
    unknown = login(client, "NoSuchTraveler", WRONG_PASSWORD)
    for response in (wrong, unknown):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"
        assert response.json()["error"]["message"] == "账号或密码不正确"
        assert WRONG_PASSWORD not in response.text
        assert response.json()["error"]["request_id"] == response.headers["x-request-id"]


def test_rotation_logout_and_old_cookie_rejected(environment):
    app, client, _, _ = environment
    register(client)
    old_cookie = client.cookies[COOKIE_NAME]
    old_csrf = csrf(client)["X-CSRF-Token"]
    assert csrf(client)["X-CSRF-Token"] == old_csrf
    result = login(client)
    assert result.status_code == 200
    new_cookie = client.cookies[COOKIE_NAME]
    assert old_cookie != new_cookie
    assert result.json()["data"]["csrf_token"] != old_csrf
    assert csrf(client)["X-CSRF-Token"] == result.json()["data"]["csrf_token"]
    with app.state.auth.sessions() as db:
        assert db.get(LoginSession, hashlib.sha256(old_cookie.encode()).hexdigest()).revoked_at
        assert db.get(LoginSession, new_cookie) is None
        assert db.get(LoginSession, hashlib.sha256(new_cookie.encode()).hexdigest()) is not None
    stale = TestClient(app)
    stale.cookies.set(COOKIE_NAME, old_cookie)
    assert stale.get("/api/v1/auth/me").status_code == 401
    response = client.post("/api/v1/auth/logout", headers=csrf(client))
    assert response.status_code == 204 and not response.content
    assert COOKIE_NAME not in client.cookies
    stale.cookies.set(COOKIE_NAME, new_cookie)
    assert stale.get("/api/v1/auth/me").status_code == 401


@pytest.mark.parametrize("endpoint", ["register", "login", "logout"])
@pytest.mark.parametrize(
    "bad_kind",
    [
        "no_token",
        "wrong_token",
        "no_origin",
        "foreign_origin",
        "null_origin",
        "origin_prefix",
        "cross_site",
        "foreign_token",
    ],
)
def test_all_auth_writes_reject_csrf(environment, endpoint, bad_kind):
    app, client, _, _ = environment
    headers = csrf(client)
    if bad_kind == "no_token":
        headers.pop("X-CSRF-Token")
    elif bad_kind == "wrong_token":
        headers["X-CSRF-Token"] = "bad-token"
    elif bad_kind == "no_origin":
        headers.pop("Origin")
    elif bad_kind == "foreign_origin":
        headers["Origin"] = "https://untrusted.example"
    elif bad_kind == "null_origin":
        headers["Origin"] = "null"
    elif bad_kind == "origin_prefix":
        headers["Origin"] = ORIGIN + ".untrusted.example"
    elif bad_kind == "cross_site":
        headers["Sec-Fetch-Site"] = "cross-site"
    else:
        headers["X-CSRF-Token"] = csrf(TestClient(app))["X-CSRF-Token"]
    response = client.post(f"/api/v1/auth/{endpoint}", headers=headers, json={})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "CSRF_FAILED"


def test_referer_fallback_and_cross_site_token_reads(environment):
    _, client, _, _ = environment
    headers = csrf(client)
    headers.pop("Origin")
    headers["Referer"] = ORIGIN + "/login"
    response = client.post("/api/v1/auth/logout", headers=headers)
    assert response.status_code == 204
    for headers in ({"Origin": "https://elsewhere.example"}, {"Sec-Fetch-Site": "cross-site"}):
        assert client.get("/api/v1/auth/csrf", headers=headers).status_code == 403


@pytest.mark.parametrize(
    "changes",
    [
        {"username": "ab"},
        {"username": "has space"},
        {"username": "汉字用户名"},
        {"username": "abc\n"},
        {"username": "a" * 33},
        {"password": "short"},
        {"password": "a" * 129},
        {"password_confirm": WRONG_PASSWORD},
        {"owner_id": "another-owner"},
    ],
)
def test_validation_is_bounded_and_does_not_echo_input(environment, changes):
    _, client, _, _ = environment
    payload = {"username": "Traveler", "password": PASSWORD, "password_confirm": PASSWORD} | changes
    response = client.post("/api/v1/auth/register", headers=csrf(client), json=payload)
    assert response.status_code == 422
    assert PASSWORD not in response.text
    assert "input" not in response.json()["error"]


def test_two_accounts_and_anonymous_authorization(environment):
    app, client, _, _ = environment
    other = TestClient(app)
    a = register(client, "Traveler_A").json()["data"]
    b = register(other, "Traveler_B").json()["data"]
    assert login(client, "traveler_a").status_code == 200
    assert login(other, "traveler_b").status_code == 200
    response_a = client.get("/api/v1/auth/me", params={"owner_id": b["id"]})
    response_b = other.get("/api/v1/auth/me", params={"user_id": a["id"]})
    assert response_a.json()["data"] == a
    assert response_b.json()["data"] == b
    assert TestClient(app).get("/api/v1/auth/me").status_code == 401
    client.post("/api/v1/auth/logout", headers=csrf(client))
    assert other.get("/api/v1/auth/me").json()["data"] == b


def test_expiry_and_forged_cookies(environment):
    _, client, _, now = environment
    headers = csrf(client)
    now[0] += ANONYMOUS_TTL
    assert client.post("/api/v1/auth/logout", headers=headers).status_code == 401
    register(client)
    login(client)
    now[0] += LOGIN_TTL
    assert client.get("/api/v1/auth/me").status_code == 401
    client.cookies.clear()
    client.cookies.set(COOKIE_NAME, "a" * 43)
    assert client.get("/api/v1/auth/me").status_code == 401


def test_restart_keeps_accounts_sessions_and_revocations(environment):
    app, client, settings, now = environment
    register(client)
    login(client)
    cookie = client.cookies[COOKIE_NAME]
    original_secret = app.state.auth.secret
    restarted = create_app(settings)
    with TestClient(restarted) as second:
        restarted.state.auth.clock = lambda: now[0]
        assert restarted.state.auth.secret == original_secret
        second.cookies.set(COOKIE_NAME, cookie, domain="testserver.local", path="/")
        assert second.get("/api/v1/auth/me").status_code == 200
        assert login(second).status_code == 200
        assert client.get("/api/v1/auth/me").status_code == 401
        active = second.cookies[COOKIE_NAME]
        second.post("/api/v1/auth/logout", headers=csrf(second))
    with TestClient(create_app(settings)) as third:
        third.app.state.auth.clock = lambda: now[0]
        third.cookies.set(COOKIE_NAME, active, domain="testserver.local", path="/")
        assert third.get("/api/v1/auth/me").status_code == 401
        assert login(third).status_code == 200


def test_account_failures_limit_and_window_expiry(environment):
    app, client, settings, now = environment
    register(client)
    for _ in range(10):
        assert login(client, "TRAVELER", WRONG_PASSWORD).status_code == 401
    response = login(client)
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) == LOGIN_WINDOW // 1000
    with TestClient(create_app(settings)) as second:
        second.app.state.auth.clock = lambda: now[0]
        assert login(second).status_code == 429
    with app.state.auth.sessions() as db:
        rows = db.scalars(select(AuthRateLimit)).all()
        assert all(len(row.key_hash) == 64 and "traveler" not in row.key_hash for row in rows)
    now[0] += LOGIN_WINDOW
    assert login(client).status_code == 200


def test_source_limit_ignores_spoofed_forwarded_for(environment):
    _, client, _, _ = environment
    headers = csrf(client)
    for i in range(60):
        response = client.post(
            "/api/v1/auth/login",
            json={
                "username": f"Missing_{i}",
                "password": PASSWORD,
            },
            headers=headers | {"X-Forwarded-For": f"192.0.2.{i + 1}"},
        )
        assert response.status_code == 401
    response = client.post(
        "/api/v1/auth/login",
        json={
            "username": "Missing_next",
            "password": PASSWORD,
        },
        headers=headers | {"X-Forwarded-For": "198.51.100.1"},
    )
    assert response.status_code == 429


def test_registration_and_anonymous_issue_limits(environment):
    app, client, _, _ = environment
    for i in range(5):
        assert register(client, f"Traveler_{i}").status_code == 201
    assert register(client, "Traveler_next").status_code == 429
    for _ in range(59):
        client.cookies.clear()
        assert client.get("/api/v1/auth/csrf").status_code == 200
    assert client.get("/api/v1/auth/csrf").status_code == 200  # 复用不消耗签发额度
    client.cookies.clear()
    assert client.get("/api/v1/auth/csrf").status_code == 429
    with app.state.auth.sessions() as db:
        assert db.scalar(select(func.count()).select_from(LoginSession)) == 60


def test_concurrent_failures_cannot_bypass_limit(environment):
    _, client, _, _ = environment
    register(client)
    headers = csrf(client)

    def attempt(_):
        return client.post(
            "/api/v1/auth/login",
            headers=headers,
            json={
                "username": "Traveler",
                "password": WRONG_PASSWORD,
            },
        ).status_code

    with ThreadPoolExecutor(max_workers=4) as executor:
        statuses = list(executor.map(attempt, range(14)))
    assert statuses.count(401) == 10
    assert statuses.count(429) == 4


def test_body_limit_counts_streamed_bytes(environment):
    _, client, _, _ = environment
    response = client.post(
        "/api/v1/auth/register", headers=csrf(client), content=iter([b"x" * 8192, b"x" * 8193])
    )
    assert response.status_code == 413


def test_storage_failure_not_reported_as_success(environment, monkeypatch):
    app, client, _, _ = environment
    headers = csrf(client)

    def unavailable(*_args):
        raise OperationalError("private SQL", {}, Exception("private path"))

    monkeypatch.setattr(app.state.auth, "consume_limit", unavailable)
    response = client.post(
        "/api/v1/auth/register",
        headers=headers,
        json={
            "username": "Traveler",
            "password": PASSWORD,
            "password_confirm": PASSWORD,
        },
    )
    assert response.status_code == 503
    assert "private SQL" not in response.text and "private path" not in response.text


def test_cookie_flags_and_https_configuration(environment):
    _, client, settings, _ = environment
    cookie = client.get("/api/v1/auth/csrf").headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
    assert "Max-Age=3600" in cookie
    assert "Secure" not in cookie
    secure_settings = settings.model_copy(update={"cookie_secure": True})
    with TestClient(create_app(secure_settings), base_url="https://testserver") as secure:
        assert "Secure" in secure.get("/api/v1/auth/csrf").headers["set-cookie"]


def test_current_user_dependency_rejects_expired_and_anonymous(environment):
    _, client, _, _ = environment
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 401 and "password_hash" not in response.text
    csrf(client)
    assert client.get("/api/v1/auth/me").status_code == 401


def test_concurrent_login_can_rotate_each_old_session_only_once(environment):
    _, client, _, _ = environment
    register(client)
    headers = csrf(client)
    old_cookie = client.cookies[COOKIE_NAME]

    def attempt(_):
        return client.post(
            "/api/v1/auth/login",
            headers={
                **headers,
                "Cookie": f"{COOKIE_NAME}={old_cookie}",
            },
            json={"username": "Traveler", "password": PASSWORD},
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = list(executor.map(attempt, range(2)))
    assert sorted(statuses) == [200, 401]


def test_concurrent_registration_keeps_one_account(environment):
    _, client, _, _ = environment
    headers = csrf(client)

    def attempt(_):
        return client.post(
            "/api/v1/auth/register",
            headers=headers,
            json={
                "username": "Traveler",
                "password": PASSWORD,
                "password_confirm": PASSWORD,
            },
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = list(executor.map(attempt, range(2)))
    assert sorted(statuses) == [201, 409]


def test_api_not_found_uses_safe_error_envelope(environment):
    _, client, _, _ = environment
    response = client.get("/api/v1/not-found")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
    assert response.json()["error"]["request_id"] == response.headers["x-request-id"]
