# 城影记后端

FastAPI、SQLAlchemy 与 Alembic 工程。开发命令统一从本目录运行，依赖由 `uv.lock` 锁定。

```powershell
uv sync --locked --python 'D:\SDK\Python\Python3.13\python.exe'
uv run alembic upgrade head
uv run uvicorn city_memories.main:app --reload --host 127.0.0.1 --port 8000 --no-proxy-headers
```

只运行单个应用实例。`--no-proxy-headers` 保证限流根据真实连接来源计数，客户端不能伪造 `X-Forwarded-For` 换地址；未来部署的代理信任范围另在 T17 配置。

配置取自项目根目录 `.env` 或 `CITY_MEMORIES_` 环境变量，示例见 [.env.example](.env.example)。默认目录为项目根目录 `.local-data`：`database/` 保存 SQLite，`originals/` 和 `staging/` 留给后续原图功能，`auth-secret.key` 在第一次启动时随机创建，之后重启沿用。不要把这些内容提交到公开仓库。

`/api/v1/auth/csrf`、`register`、`login`、`me`、`logout` 已实现。修改请求必须携带当前会话 Cookie、可信的 Origin/Referer 和 `X-CSRF-Token`；密码、Token、数据库路径不出现在错误响应里。OpenAPI 由运行服务的 `/docs` 提供。

```powershell
uv run ruff check .
uv run pytest -q
```

测试只用临时数据库。`test_process_restart.py` 会在临时端口启动并停止真实 Uvicorn；前端 `npm run test:e2e` 调用 `tests/serve_e2e.py`，在临时数据目录验证实际 Edge。
