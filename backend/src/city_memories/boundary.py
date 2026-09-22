"""统一 API 响应缓存策略、修改请求 CSRF 和认证请求体大小边界。"""

from uuid import uuid4

from sqlalchemy.exc import OperationalError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from city_memories.errors import ApiError, error_response


class ApiBoundary:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive)
        request.state.request_id = str(uuid4())

        async def protected_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "private, no-store"
                headers["X-Request-ID"] = request.state.request_id
                headers["X-Content-Type-Options"] = "nosniff"
            await send(message)

        try:
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                await run_in_threadpool(request.app.state.auth.check_csrf, request)
            if scope["path"].startswith("/api/v1/auth/") and request.method == "POST":
                # 在 JSON 解析之前计实际字节，不信任 Content-Length。
                body = bytearray()
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunk = message.get("body", b"")
                    if len(body) + len(chunk) > 16 * 1024:
                        raise ApiError(413, "REQUEST_TOO_LARGE", "请求内容过大")
                    body.extend(chunk)
                    if not message.get("more_body", False):
                        break

                async def buffered_receive() -> Message:
                    return {"type": "http.request", "body": bytes(body), "more_body": False}

                receive = buffered_receive
            await self.app(scope, receive, protected_send)
        except ApiError as error:
            await error_response(request, error)(scope, receive, protected_send)
        except OperationalError:
            error = ApiError(503, "STORAGE_UNAVAILABLE", "暂时无法保存或读取，请稍后重试")
            await error_response(request, error)(scope, receive, protected_send)
