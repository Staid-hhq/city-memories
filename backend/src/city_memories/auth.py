"""单实例的会话和认证服务；密码运算不持有数据库事务。"""

import hashlib
import hmac
import math
import os
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, Request, Response
from pwdlib import PasswordHash
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator
from sqlalchemy import Engine, select, update
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from city_memories.config import Settings
from city_memories.errors import ApiError
from city_memories.models import AuthRateLimit, LoginSession, User

COOKIE_NAME = "city_memories_session"
ANONYMOUS_TTL = 60 * 60 * 1000
LOGIN_TTL = 7 * 24 * 60 * 60 * 1000
LOGIN_WINDOW = 15 * 60 * 1000
HOUR = 60 * 60 * 1000


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=3, max_length=32)
    password: SecretStr = Field(min_length=15, max_length=128)

    @field_validator("username")
    @classmethod
    def username_format(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_]{3,32}", value):
            raise ValueError("用户名须为 3–32 位英文字母、数字或下划线")
        return value


class Registration(Credentials):
    password_confirm: SecretStr = Field(min_length=15, max_length=128)

    @model_validator(mode="after")
    def passwords_match(self) -> "Registration":
        if self.password.get_secret_value() != self.password_confirm.get_secret_value():
            raise ValueError("两次输入的密码不一致")
        return self


class UserView(BaseModel):
    id: str
    username: str
    created_at: datetime


class UserResponse(BaseModel):
    data: UserView


class CsrfData(BaseModel):
    csrf_token: str


class CsrfResponse(BaseModel):
    data: CsrfData


class LoginData(CsrfData):
    user: UserView


class LoginResponse(BaseModel):
    data: LoginData


@dataclass(frozen=True)
class Identity:
    token_hash: str
    user_id: str | None
    csrf_token: str
    expires_at: int


def read_or_create_secret(settings: Settings) -> bytes:
    if settings.auth_secret is not None:
        return settings.auth_secret.get_secret_value().encode()
    path = settings.data_dir / "auth-secret.key"
    try:
        with path.open("xb") as stream:
            stream.write(secrets.token_bytes(32))
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        pass
    secret = path.read_bytes()
    if len(secret) < 32:
        raise RuntimeError("本地认证密钥文件不完整，请检查私有数据目录")
    return secret


class AuthService:
    def __init__(self, engine: Engine, settings: Settings, clock: Callable[[], int] | None = None):
        self.sessions = sessionmaker(engine, expire_on_commit=False)
        self.settings = settings
        self.clock = clock or (lambda: time.time_ns() // 1_000_000)
        self.secret = read_or_create_secret(settings)
        self.passwords = PasswordHash.recommended()
        self.dummy_hash = self.passwords.hash(secrets.token_urlsafe(32))
        # 当前架构为单实例。认证锁避免并发绕过失败次数或重复使用旧会话。
        # 哈希计算在锁内，但始终在数据库事务外；普通私人读取不受此锁限制。
        self.lock = threading.Lock()

    def _session(self, raw_token: str | None) -> Identity | None:
        if raw_token is None or not re.fullmatch(r"[A-Za-z0-9_-]{43}", raw_token):
            return None
        digest = hashlib.sha256(raw_token.encode()).hexdigest()
        with self.sessions() as db:
            item = db.get(LoginSession, digest)
            if item is None or item.revoked_at is not None or item.expires_at <= self.clock():
                return None
            return Identity(item.token_hash, item.user_id, item.csrf_token, item.expires_at)

    def require_session(self, request: Request) -> Identity:
        identity = self._session(request.cookies.get(COOKIE_NAME))
        if identity is None:
            raise ApiError(401, "SESSION_EXPIRED", "登录状态已失效，请重新登录")
        return identity

    def check_origin(self, request: Request, *, required: bool) -> None:
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise ApiError(403, "CSRF_FAILED", "请求来源不受信任，请从本站重新操作")
        origin = request.headers.get("origin")
        referer = request.headers.get("referer")
        if origin is None and referer:
            try:
                parsed = urlsplit(referer)
                origin = f"{parsed.scheme}://{parsed.netloc}"
            except ValueError:
                origin = "invalid"
        if (required and origin is None) or (
            origin is not None and origin not in self.settings.allowed_origins
        ):
            raise ApiError(403, "CSRF_FAILED", "请求来源不受信任，请从本站重新操作")

    def check_csrf(self, request: Request) -> Identity:
        self.check_origin(request, required=True)
        identity = self.require_session(request)
        supplied = request.headers.get("x-csrf-token", "")
        if len(supplied) > 128 or not hmac.compare_digest(
            supplied.encode(), identity.csrf_token.encode()
        ):
            raise ApiError(403, "CSRF_FAILED", "页面状态已改变，请刷新后重试")
        return identity

    def _key(self, scope: str, value: str) -> str:
        return hmac.new(self.secret, f"{scope}\0{value}".encode(), hashlib.sha256).hexdigest()

    def _limited(self, now: int, window: int) -> ApiError:
        retry = math.ceil(((now // window + 1) * window - now) / 1000)
        return ApiError(
            429, "RATE_LIMITED", "操作过于频繁，请稍后再试", {"Retry-After": str(max(1, retry))}
        )

    def consume_limit(self, scope: str, value: str, limit: int, window: int) -> None:
        now = self.clock()
        statement = (
            insert(AuthRateLimit)
            .values(
                scope=scope,
                key_hash=self._key(scope, value),
                window_start=now // window * window,
                attempts=1,
                expires_at=(now // window + 1) * window,
            )
            .on_conflict_do_update(
                index_elements=["scope", "key_hash", "window_start"],
                set_={"attempts": AuthRateLimit.attempts + 1},
                where=AuthRateLimit.attempts < limit,
            )
            .returning(AuthRateLimit.attempts)
        )
        with self.sessions.begin() as db:
            result = db.scalar(statement)
        if result is None:
            raise self._limited(now, window)

    def check_failures(self, username_key: str) -> None:
        now = self.clock()
        with self.sessions() as db:
            row = db.get(
                AuthRateLimit,
                (
                    "login_failure",
                    self._key("login_failure", username_key),
                    now // LOGIN_WINDOW * LOGIN_WINDOW,
                ),
            )
            if row is not None and row.attempts >= 10:
                raise self._limited(now, LOGIN_WINDOW)

    def _new_session(self, db: Session, user_id: str | None) -> tuple[str, Identity]:
        raw = secrets.token_urlsafe(32)
        now = self.clock()
        identity = Identity(
            hashlib.sha256(raw.encode()).hexdigest(),
            user_id,
            secrets.token_urlsafe(32),
            now + (LOGIN_TTL if user_id else ANONYMOUS_TTL),
        )
        db.add(
            LoginSession(
                token_hash=identity.token_hash,
                user_id=user_id,
                csrf_token=identity.csrf_token,
                created_at=now,
                expires_at=identity.expires_at,
                last_seen_at=now,
            )
        )
        return raw, identity

    def csrf(self, request: Request, response: Response) -> CsrfResponse:
        self.check_origin(request, required=False)
        with self.lock:
            identity = self._session(request.cookies.get(COOKIE_NAME))
            if identity is None:
                self.consume_limit("anonymous", source(request), 60, HOUR)
                with self.sessions.begin() as db:
                    raw, identity = self._new_session(db, None)
                self.set_cookie(response, raw, ANONYMOUS_TTL)
        return CsrfResponse(data=CsrfData(csrf_token=identity.csrf_token))

    def register(self, request: Request, data: Registration) -> UserResponse:
        with self.lock:
            self.check_csrf(request)
            self.consume_limit("register", source(request), 5, HOUR)
            password_hash = self.passwords.hash(data.password.get_secret_value())
            user = User(
                id=str(uuid4()),
                username=data.username,
                username_key=data.username.lower(),
                password_hash=password_hash,
                created_at=self.clock(),
            )
            try:
                with self.sessions.begin() as db:
                    db.add(user)
            except IntegrityError as exc:
                raise ApiError(409, "USERNAME_TAKEN", "这个用户名已被使用，请换一个") from exc
        return UserResponse(data=user_view(user))

    def login(self, request: Request, response: Response, data: Credentials) -> LoginResponse:
        with self.lock:
            old = self.check_csrf(request)
            self.consume_limit("login_source", source(request), 60, LOGIN_WINDOW)
            key = data.username.lower()
            self.check_failures(key)
            with self.sessions() as db:
                user = db.scalar(select(User).where(User.username_key == key))
            valid = self.passwords.verify(
                data.password.get_secret_value(), user.password_hash if user else self.dummy_hash
            )
            if not valid or user is None:
                self.consume_limit("login_failure", key, 10, LOGIN_WINDOW)
                raise ApiError(401, "INVALID_CREDENTIALS", "账号或密码不正确")
            if old.expires_at <= self.clock():
                raise ApiError(401, "SESSION_EXPIRED", "页面已过期，请刷新后重试")
            with self.sessions.begin() as db:
                db.execute(
                    update(LoginSession)
                    .where(
                        LoginSession.token_hash == old.token_hash,
                    )
                    .values(revoked_at=self.clock())
                )
                raw, identity = self._new_session(db, user.id)
            self.set_cookie(response, raw, LOGIN_TTL)
        return LoginResponse(data=LoginData(user=user_view(user), csrf_token=identity.csrf_token))

    def logout(self, request: Request, response: Response) -> None:
        with self.lock:
            identity = self.check_csrf(request)
            with self.sessions.begin() as db:
                db.execute(
                    update(LoginSession)
                    .where(
                        LoginSession.token_hash == identity.token_hash,
                    )
                    .values(revoked_at=self.clock())
                )
        response.delete_cookie(
            COOKIE_NAME, path="/", secure=self.settings.cookie_secure, httponly=True, samesite="lax"
        )

    def set_cookie(self, response: Response, token: str, ttl: int) -> None:
        response.set_cookie(
            COOKIE_NAME,
            token,
            max_age=ttl // 1000,
            path="/",
            secure=self.settings.cookie_secure,
            httponly=True,
            samesite="lax",
        )


def source(request: Request) -> str:
    # Uvicorn 以 --no-proxy-headers 启动；不读取客户端提供的 X-Forwarded-For。
    return request.client.host if request.client else "unknown"


def user_view(user: User) -> UserView:
    return UserView(
        id=user.id,
        username=user.username,
        created_at=datetime.fromtimestamp(user.created_at / 1000, UTC),
    )


def current_user(request: Request) -> User:
    service: AuthService = request.app.state.auth
    identity = service.require_session(request)
    if identity.user_id is None:
        raise ApiError(401, "AUTH_REQUIRED", "请先登录")
    with service.sessions() as db:
        user = db.get(User, identity.user_id)
    if user is None:
        raise ApiError(401, "AUTH_REQUIRED", "请先登录")
    return user


CurrentUser = Annotated[User, Depends(current_user)]
router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.get("/csrf", response_model=CsrfResponse)
def csrf(request: Request, response: Response) -> CsrfResponse:
    return request.app.state.auth.csrf(request, response)


@router.post("/register", status_code=201, response_model=UserResponse)
def register(request: Request, data: Registration) -> UserResponse:
    return request.app.state.auth.register(request, data)


@router.post("/login", response_model=LoginResponse)
def login(request: Request, response: Response, data: Credentials) -> LoginResponse:
    return request.app.state.auth.login(request, response, data)


@router.get("/me", response_model=UserResponse)
def me(user: CurrentUser) -> UserResponse:
    return UserResponse(data=user_view(user))


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response) -> None:
    request.app.state.auth.logout(request, response)
