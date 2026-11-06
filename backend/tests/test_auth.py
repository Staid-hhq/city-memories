import hashlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path
from threading import Event
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import event, func, select
from sqlalchemy.exc import OperationalError

from city_memories.auth import ANONYMOUS_TTL, COOKIE_NAME, LOGIN_TTL, LOGIN_WINDOW, Registration
from city_memories.config import Settings, get_settings
from city_memories.main import create_app
from city_memories.models import AuthRateLimit, LoginSession, User

PASSWORD = "UiTest_2026!"
WRONG_PASSWORD = "Wrong_Pass2026!"
NEW_PASSWORD = "New_Trip2026!"
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
        cleanup_enabled=False,  # T10 has separate controlled-clock lifecycle tests.
        _env_file=None,
    )
    # Legacy tests simulate overlapping app restarts with one controlled clock.
    # T10 separately verifies the real OS guard, including actual child processes.
    monkeypatch.setattr("city_memories.main.InstanceLock", lambda directory: nullcontext())
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


def change_password(client, user_id, *, headers=None, **changes):
    payload = {
        "expected_user_id": user_id,
        "current_password": PASSWORD,
        "password": NEW_PASSWORD,
        "password_confirm": NEW_PASSWORD,
    } | changes
    return client.post(
        "/api/v1/auth/password",
        headers=csrf(client) if headers is None else headers,
        json=payload,
    )


@pytest.fixture
def authenticated(environment):
    _, client, _, _ = environment
    user = register(client).json()["data"]
    assert login(client).status_code == 200
    return (*environment, user)


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
        assert not app.state.auth.passwords.verify(PASSWORD.swapcase(), user.password_hash)
        assert PASSWORD not in user.password_hash


@pytest.mark.parametrize(
    "password",
    ["Abc!2345", "Abcdefgh1234!@#$", "riverbank", "TRAVELER", "90274635", "!@#$%^&*"],
)
def test_registration_accepts_boundaries_without_requiring_character_mixtures(
    environment, password
):
    app, client, _, _ = environment
    response = register(client, password=password)
    assert response.status_code == 201
    assert login(client, password=password).status_code == 200
    with app.state.auth.sessions() as db:
        user = db.scalar(select(User))
        assert app.state.auth.passwords.verify(password, user.password_hash)
        if password.swapcase() != password:
            assert not app.state.auth.passwords.verify(password.swapcase(), user.password_hash)


@pytest.mark.parametrize("field", ["password", "password_confirm"])
@pytest.mark.parametrize(
    ("password", "issue"),
    [
        ("Ab!1234", "LENGTH"),
        ("Abcdefgh1234!@#$%", "LENGTH"),
        ("Abcdefg中", "CHARACTERS"),
        (" Abcdefg", "CHARACTERS"),
        ("Abcdefg ", "CHARACTERS"),
        ("Abcdefg\t", "CHARACTERS"),
        ("Abcdefg\n", "CHARACTERS"),
        ("Abcdefg\u00a0", "CHARACTERS"),
        ("Abcdefg！", "CHARACTERS"),
        ("Abcdefg😀", "CHARACTERS"),
        ("Abcdefg\x7f", "CHARACTERS"),
        ("PaSsWoRd123!", "COMMON"),
    ],
)
def test_registration_password_errors_identify_field_without_echoing_input(
    environment, field, password, issue
):
    app, client, _, _ = environment
    payload = {"username": "Traveler", "password": PASSWORD, "password_confirm": PASSWORD}
    payload[field] = password
    response = client.post("/api/v1/auth/register", headers=csrf(client), json=payload)
    assert response.status_code == 422
    error = response.json()["error"]
    prefix = "PASSWORD_CONFIRM" if field == "password_confirm" else "PASSWORD"
    label = "确认密码" if field == "password_confirm" else "密码"
    messages = {
        "LENGTH": f"{label}长度须为 8–16 位。",
        "CHARACTERS": (
            f"{label}仅支持英文字母、数字和英文半角符号，不支持中文、空格或其他字符。"
        ),
        "COMMON": (
            "确认密码过于常见，请换一个不易猜到的密码。"
            if field == "password_confirm"
            else "该密码过于常见，请换一个不易猜到的密码。"
        ),
    }
    assert error["code"] == f"{prefix}_{issue}"
    assert error["message"] == messages[issue]
    assert set(error) == {"code", "message", "request_id"}
    assert error["request_id"] == response.headers["x-request-id"]
    assert PASSWORD not in response.text
    assert password not in response.text
    with app.state.auth.sessions() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0


@pytest.mark.parametrize(
    "password",
    [
        "12345678", "123456789", "1234567890", "87654321", "00000000", "11111111",
        "88888888", "password", "password1", "password123", "password123!", "qwertyui",
        "qwertyuiop", "qwerty123", "abcd1234", "abc12345", "iloveyou", "welcome1",
        "admin123", "admin12345", "letmein1", "changeme", "cijianji",
    ],
)
def test_registration_rejects_bounded_common_passwords_case_insensitively(password):
    for candidate in (password, password.upper()):
        with pytest.raises(ValidationError) as caught:
            Registration(username="Traveler", password=candidate, password_confirm=PASSWORD)
        assert caught.value.errors()[0]["type"] == "password_common"


def test_common_password_check_matches_only_whole_password():
    data = Registration(
        username="Traveler", password="MyPassword123!", password_confirm="MyPassword123!"
    )
    assert data.password.get_secret_value() == "MyPassword123!"


def test_registration_mismatch_has_fixed_safe_error(environment):
    _, client, _, _ = environment
    response = client.post(
        "/api/v1/auth/register",
        headers=csrf(client),
        json={"username": "Traveler", "password": PASSWORD, "password_confirm": WRONG_PASSWORD},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PASSWORD_MISMATCH"
    assert response.json()["error"]["message"] == "两次输入的密码不一致，请重新核对。"
    assert PASSWORD not in response.text and WRONG_PASSWORD not in response.text


@pytest.mark.parametrize(
    "password",
    [
        " " + "旅" * 14 + "x ",  # 17 Unicode code points, including surrounding spaces.
        " " + "旅" * 125 + "x ",  # 128 code points; beyond the new registration maximum.
        "  测试专用的旅行短句 password 2026  ",
        "Legacy_Pass2026!?",
    ],
)
def test_existing_password_hashes_login_unchanged_outside_registration_policy(
    environment, password
):
    app, client, _, now = environment
    original_hash = app.state.auth.passwords.hash(password)
    with app.state.auth.sessions.begin() as db:
        db.add(
            User(
                id=str(uuid4()),
                username="LegacyTraveler",
                username_key="legacytraveler",
                password_hash=original_hash,
                created_at=now[0],
            )
        )
    assert login(client, "LegacyTraveler", password).status_code == 200
    for changed in {password.strip(), password.swapcase(), password[:16]} - {password}:
        assert login(client, "LegacyTraveler", changed).status_code == 401
    with app.state.auth.sessions() as db:
        assert db.scalar(select(User.password_hash)) == original_hash


@pytest.mark.parametrize("password", ["x" * 7, "旅" * 129])
def test_login_password_length_remains_bounded_without_echoing_input(environment, password):
    _, client, _, _ = environment
    response = login(client, password=password)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"
    assert set(response.json()["error"]) == {"code", "message", "request_id"}
    assert password not in response.text


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


@pytest.mark.parametrize("endpoint", ["register", "login", "logout", "password"])
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


def test_password_change_revokes_all_owned_sessions_and_keeps_other_account(authenticated):
    app, client, _, _, user = authenticated
    sibling = TestClient(app)
    other = TestClient(app)
    assert login(sibling).status_code == 200
    other_user = register(other, "OtherTraveler").json()["data"]
    assert login(other, "OtherTraveler").status_code == 200
    response = change_password(client, user["id"])
    assert response.status_code == 204 and not response.content
    assert 'Max-Age=0' in response.headers["set-cookie"]
    assert client.get("/api/v1/auth/me").status_code == 401
    assert sibling.get("/api/v1/auth/me").status_code == 401
    assert other.get("/api/v1/auth/me").json()["data"]["id"] == other_user["id"]
    with app.state.auth.sessions() as db:
        owned = db.scalars(select(LoginSession).where(LoginSession.user_id == user["id"])).all()
        assert len(owned) == 2 and all(item.revoked_at is not None for item in owned)
        untouched = db.scalars(
            select(LoginSession).where(LoginSession.user_id == other_user["id"])
        ).all()
        assert all(item.revoked_at is None for item in untouched)
        assert app.state.auth.passwords.verify(NEW_PASSWORD, db.get(User, user["id"]).password_hash)
        assert app.state.auth.passwords.verify(
            PASSWORD, db.get(User, other_user["id"]).password_hash
        )
        limits = db.scalars(
            select(AuthRateLimit).where(AuthRateLimit.scope.like("password_change_%"))
        ).all()
        assert {item.scope: item.attempts for item in limits} == {
            "password_change_source": 1, "password_change_user": 1,
        }
    assert login(client).status_code == 401
    assert login(client, password=NEW_PASSWORD).status_code == 200


@pytest.mark.parametrize(
    ("current", "new"),
    [
        ("Abc!2345", "New!2345"),
        ("Abcdefgh1234!@#$", "Newpass1234!@#$%"),
        (" " + "旅" * 14 + "x ", NEW_PASSWORD),
        (" " + "旅" * 125 + "x ", NEW_PASSWORD),
    ],
)
def test_password_change_accepts_existing_current_password_without_normalization(
    environment, current, new
):
    app, client, _, now = environment
    user_id = str(uuid4())
    with app.state.auth.sessions.begin() as db:
        db.add(User(
            id=user_id, username="LegacyTraveler", username_key="legacytraveler",
            password_hash=app.state.auth.passwords.hash(current), created_at=now[0],
        ))
    assert login(client, "LegacyTraveler", current).status_code == 200
    if current.strip() != current:
        response = change_password(client, user_id, current_password=current.strip())
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "CURRENT_PASSWORD_INCORRECT"
    assert change_password(
        client, user_id, current_password=current, password=new, password_confirm=new
    ).status_code == 204
    assert login(client, "LegacyTraveler", current).status_code == 401
    assert login(client, "LegacyTraveler", new).status_code == 200


@pytest.mark.parametrize(
    ("changes", "code"),
    [
        ({"current_password": "Ab!1234"}, "CURRENT_PASSWORD_LENGTH"),
        ({"current_password": "旅" * 129}, "CURRENT_PASSWORD_LENGTH"),
        ({"password": "Ab!1234"}, "PASSWORD_LENGTH"),
        ({"password": "Abcdefgh1234!@#$%"}, "PASSWORD_LENGTH"),
        ({"password": "Abcdefg中"}, "PASSWORD_CHARACTERS"),
        ({"password": " Abcdefg"}, "PASSWORD_CHARACTERS"),
        ({"password": "PaSsWoRd123!"}, "PASSWORD_COMMON"),
        ({"password_confirm": "Ab!1234"}, "PASSWORD_CONFIRM_LENGTH"),
        ({"password_confirm": "Abcdefgh1234!@#$%"}, "PASSWORD_CONFIRM_LENGTH"),
        ({"password_confirm": "Abcdefg中"}, "PASSWORD_CONFIRM_CHARACTERS"),
        ({"password_confirm": "Abcdefg "}, "PASSWORD_CONFIRM_CHARACTERS"),
        ({"password_confirm": "PaSsWoRd123!"}, "PASSWORD_CONFIRM_COMMON"),
        ({"password_confirm": "Other_Trip2026!"}, "PASSWORD_MISMATCH"),
        ({"owner_id": "another-account"}, "VALIDATION_FAILED"),
    ],
)
def test_password_change_validation_is_specific_and_never_echoes_secrets(
    authenticated, changes, code
):
    app, client, _, _, user = authenticated
    with app.state.auth.sessions() as db:
        original_hash = db.get(User, user["id"]).password_hash
    response = change_password(client, user["id"], **changes)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == code
    assert set(response.json()["error"]) == {"code", "message", "request_id"}
    assert PASSWORD not in response.text and NEW_PASSWORD not in response.text
    assert all(value not in response.text for value in changes.values())
    assert client.get("/api/v1/auth/me").status_code == 200
    with app.state.auth.sessions() as db:
        assert db.get(User, user["id"]).password_hash == original_hash


@pytest.mark.parametrize(
    ("changes", "status", "code"),
    [
        ({"current_password": WRONG_PASSWORD}, 400, "CURRENT_PASSWORD_INCORRECT"),
        ({"password": PASSWORD, "password_confirm": PASSWORD}, 422, "PASSWORD_UNCHANGED"),
        ({"expected_user_id": "another-account"}, 409, "ACCOUNT_CHANGED"),
    ],
)
def test_password_change_refusals_preserve_password_and_session(
    authenticated, changes, status, code
):
    app, client, _, _, user = authenticated
    response = change_password(client, user["id"], **changes)
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert PASSWORD not in response.text and WRONG_PASSWORD not in response.text
    assert NEW_PASSWORD not in response.text
    assert client.get("/api/v1/auth/me").json()["data"]["id"] == user["id"]
    with app.state.auth.sessions() as db:
        assert app.state.auth.passwords.verify(PASSWORD, db.get(User, user["id"]).password_hash)


def test_password_change_requires_authenticated_unexpired_session(environment):
    app, client, _, now = environment
    response = change_password(client, "unowned-account")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"
    user = register(client).json()["data"]
    assert login(client).status_code == 200
    headers = csrf(client)
    now[0] += LOGIN_TTL
    response = change_password(client, user["id"], headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "SESSION_EXPIRED"
    with app.state.auth.sessions() as db:
        assert app.state.auth.passwords.verify(PASSWORD, db.get(User, user["id"]).password_hash)


def test_password_change_user_limit_persists_and_expires(authenticated):
    app, client, settings, now, user = authenticated
    headers = csrf(client)
    cookie = client.cookies[COOKIE_NAME]
    for _ in range(10):
        assert change_password(
            client, user["id"], headers=headers, current_password=WRONG_PASSWORD
        ).status_code == 400
    response = change_password(client, user["id"], headers=headers)
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) == LOGIN_WINDOW // 1000
    restarted = create_app(settings)
    with TestClient(restarted) as second:
        restarted.state.auth.clock = lambda: now[0]
        response = change_password(
            second, user["id"], headers=headers | {"Cookie": f"{COOKIE_NAME}={cookie}"}
        )
        assert response.status_code == 429
    with app.state.auth.sessions() as db:
        limits = db.scalars(select(AuthRateLimit)).all()
        assert all(user["id"] not in item.key_hash for item in limits)
        assert all(len(item.key_hash) == 64 for item in limits)
    now[0] += LOGIN_WINDOW
    assert change_password(client, user["id"], headers=headers).status_code == 204


def test_password_change_source_limit_covers_multiple_accounts_and_ignores_forwarded_for(
    environment,
):
    app, _, _, _ = environment
    accounts = []
    for index in range(4):
        client = TestClient(app)
        name = f"SourceTraveler_{index}"
        user = register(client, name).json()["data"]
        assert login(client, name).status_code == 200
        accounts.append((client, user["id"], csrf(client)))
    for client, user_id, headers in accounts[:3]:
        for index in range(10):
            response = change_password(
                client, user_id, current_password=WRONG_PASSWORD,
                headers=headers | {"X-Forwarded-For": f"192.0.2.{index}"},
            )
            assert response.status_code == 400
    client, user_id, headers = accounts[-1]
    response = change_password(client, user_id, headers=headers)
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) == LOGIN_WINDOW // 1000
    assert client.get("/api/v1/auth/me").status_code == 200


def test_password_change_rolls_back_hash_if_session_revocation_fails(authenticated):
    app, client, _, _, user = authenticated
    sibling = TestClient(app)
    assert login(sibling).status_code == 200
    with app.state.auth.sessions() as db:
        original_hash = db.get(User, user["id"]).password_hash

    def fail_revocation(conn, cursor, statement, parameters, context, many):
        if statement.startswith("UPDATE sessions SET revoked_at") and "user_id" in statement:
            raise OperationalError("private SQL", {}, Exception("private path"))

    event.listen(app.state.engine, "before_cursor_execute", fail_revocation)
    try:
        response = change_password(client, user["id"])
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail_revocation)
    assert response.status_code == 503
    assert "set-cookie" not in response.headers
    assert all(secret not in response.text for secret in [PASSWORD, NEW_PASSWORD, "private SQL"])
    with app.state.auth.sessions() as db:
        assert db.get(User, user["id"]).password_hash == original_hash
    assert client.get("/api/v1/auth/me").status_code == 200
    assert sibling.get("/api/v1/auth/me").status_code == 200
    assert change_password(client, user["id"]).status_code == 204


def test_password_change_hashing_has_no_transaction_and_rechecks_expiry(authenticated, monkeypatch):
    app, client, _, now, user = authenticated
    verify = app.state.auth.passwords.verify
    hash_password = app.state.auth.passwords.hash

    def checked_verify(*args):
        assert app.state.engine.pool.checkedout() == 0
        return verify(*args)

    def slow_hash(*args):
        assert app.state.engine.pool.checkedout() == 0
        result = hash_password(*args)
        now[0] += LOGIN_TTL
        return result

    monkeypatch.setattr(app.state.auth.passwords, "verify", checked_verify)
    monkeypatch.setattr(app.state.auth.passwords, "hash", slow_hash)
    response = change_password(client, user["id"])
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "SESSION_EXPIRED"
    with app.state.auth.sessions() as db:
        assert verify(PASSWORD, db.get(User, user["id"]).password_hash)
        assert all(item.revoked_at is None for item in db.scalars(
            select(LoginSession).where(LoginSession.user_id == user["id"])
        ))


def test_concurrent_password_changes_have_one_winner(authenticated):
    app, client, _, _, user = authenticated
    headers = csrf(client) | {"Cookie": f"{COOKIE_NAME}={client.cookies[COOKIE_NAME]}"}
    passwords = [NEW_PASSWORD, "Other_Trip2026!"]

    def attempt(password):
        return change_password(
            client, user["id"], headers=headers, password=password, password_confirm=password
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(attempt, passwords))
    assert sorted(response.status_code for response in responses) == [204, 401]
    winner = passwords[next(index for index, response in enumerate(responses)
                            if response.status_code == 204)]
    with app.state.auth.sessions() as db:
        assert app.state.auth.passwords.verify(winner, db.get(User, user["id"]).password_hash)
    fresh = TestClient(app)
    assert login(fresh, password=winner).status_code == 200


@pytest.mark.parametrize("first", ["login", "change"])
def test_password_change_serializes_with_old_password_login(authenticated, monkeypatch, first):
    app, client, _, _, user = authenticated
    fresh = TestClient(app)
    login_headers = csrf(fresh) | {"Cookie": f"{COOKIE_NAME}={fresh.cookies[COOKIE_NAME]}"}
    change_headers = csrf(client) | {"Cookie": f"{COOKIE_NAME}={client.cookies[COOKIE_NAME]}"}
    entered, release = Event(), Event()
    verify = app.state.auth.passwords.verify
    calls = 0

    def held_verify(*args):
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            assert release.wait(10)
        return verify(*args)

    monkeypatch.setattr(app.state.auth.passwords, "verify", held_verify)

    def attempt(kind):
        if kind == "change":
            return change_password(client, user["id"], headers=change_headers)
        return fresh.post(
            "/api/v1/auth/login", headers=login_headers,
            json={"username": "Traveler", "password": PASSWORD},
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        leading = executor.submit(attempt, first)
        try:
            assert entered.wait(10)
            trailing = executor.submit(attempt, "change" if first == "login" else "login")
        finally:
            release.set()
        leading_response, trailing_response = leading.result(15), trailing.result(15)
    expected = (200, 204) if first == "login" else (204, 401)
    assert (leading_response.status_code, trailing_response.status_code) == expected
    with app.state.auth.sessions() as db:
        assert verify(NEW_PASSWORD, db.get(User, user["id"]).password_hash)
        owned = db.scalars(select(LoginSession).where(LoginSession.user_id == user["id"])).all()
        assert all(item.revoked_at is not None for item in owned)
    assert fresh.get("/api/v1/auth/me").status_code == 401
