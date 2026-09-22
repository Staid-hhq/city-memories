from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from city_memories.albums import router as albums_router
from city_memories.auth import AuthService, router
from city_memories.boundary import ApiBoundary
from city_memories.config import Settings
from city_memories.database import build_engine
from city_memories.errors import ApiError, error_response
from city_memories.imports import ImportService
from city_memories.imports import router as imports_router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = build_engine(settings)
        try:
            with engine.connect() as connection:
                # 缺失迁移时拒绝启动，避免登录时才报缺表。
                connection.execute(text("SELECT token_hash FROM sessions LIMIT 1"))
            app.state.engine = engine
            app.state.auth = AuthService(engine, settings)
            app.state.imports = ImportService(app.state.auth)
            yield
        finally:
            engine.dispose()

    app = FastAPI(title="城影记 API", version="0.4.0", lifespan=lifespan)
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=list({urlsplit(origin).hostname for origin in settings.allowed_origins}),
    )
    app.add_middleware(ApiBoundary)

    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, error: ApiError):
        return error_response(request, error)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, _error: RequestValidationError):
        # 不回显 Pydantic 的 input / 请求体，避免在错误响应中泄露密码。
        return error_response(
            request,
            ApiError(
                422,
                "VALIDATION_FAILED",
                "请检查用户名、密码长度及两次密码是否一致"
                if request.url.path.startswith("/api/v1/auth/")
                else "请检查输入：年份和分页参数须有效，文件名、大小和校验信息须完整",
            ),
        )

    @app.exception_handler(HTTPException)
    async def handle_http_error(request: Request, error: HTTPException):
        code, message = {
            404: ("NOT_FOUND", "请求的内容不存在"),
            405: ("METHOD_NOT_ALLOWED", "不支持这种请求方式"),
        }.get(error.status_code, ("REQUEST_FAILED", "请求未能完成"))
        return error_response(request, ApiError(error.status_code, code, message, error.headers))

    @app.exception_handler(OperationalError)
    @app.exception_handler(OSError)
    async def handle_storage_error(request: Request, _error: Exception):
        return error_response(
            request,
            ApiError(
                503,
                "STORAGE_UNAVAILABLE",
                "暂时无法保存或读取，请稍后重试",
            ),
        )

    @app.get("/api/v1/health")
    def health(request: Request) -> dict[str, dict[str, str]]:
        with request.app.state.engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return {"data": {"status": "ok"}}

    app.include_router(router)
    app.include_router(albums_router)
    app.include_router(imports_router)
    return app


app = create_app()
