# 城影记后端

FastAPI、SQLAlchemy 与 Alembic 工程。开发命令统一从本目录运行，依赖由 `uv.lock` 锁定。

```powershell
uv sync --locked --python 'D:\SDK\Python\Python3.13\python.exe'
uv run python -m alembic upgrade head
uv run uvicorn city_memories.main:app --reload --host 127.0.0.1 --port 8000 --no-proxy-headers
```

只运行单个应用实例。`--no-proxy-headers` 保证限流根据真实连接来源计数，客户端不能伪造 `X-Forwarded-For` 换地址；未来部署的代理信任范围另在 T17 配置。

配置取自项目根目录 `.env` 或 `CITY_MEMORIES_` 环境变量，示例见 [.env.example](.env.example)。默认目录为项目根目录 `.local-data`：`database/` 保存 SQLite，`originals/` 保存独立原图副本，`staging/` 保存待提交图片；`auth-secret.key` 在第一次启动时随机创建，之后重启沿用。不要把这些内容提交到公开仓库。

`/api/v1/auth/csrf`、`register`、`login`、`me`、`logout` 已实现。修改请求必须携带当前会话 Cookie、可信的 Origin/Referer 和 `X-CSRF-Token`；密码、Token、数据库路径不出现在错误响应里。OpenAPI 由运行服务的 `/docs` 提供。

T03 新增 `/api/v1/cities`、`/me/atlas`、`/cities/{city_id}/albums`（GET/POST）和 `/albums/{album_id}`；均要求登录，具体影集必须属于会话本人。迁移 `b61e24f803a7` 加入三个公共城市映射，详情和已测边界见 [T03 记录](../docs/t03-albums-verification.md)。年份为严格整数 1–9999 或 null，重复创建返回原影集；城市与年份列表有签名游标分页，不能用私人游标跨账号读取。

T04 新增创建导入、逐文件接收、状态查询、提交和取消，以及 `/photos/{photo_id}/original`。沿用现有表和依赖，不新增迁移。先校验权限再读取 multipart；实际格式、大小、像素和 SHA256 均由服务端核验。原始字节不重编码，文件先就绪、照片记录和幂等收据再通过短事务一起保存。详细请求格式、50 MiB/8000 万像素限制、租约和失败恢复边界见 [接口契约](../docs/data-api-design.md#6-导入协议与失败恢复) 与 [T04 记录](../docs/t04-originals-verification.md)。

当前仅支持单实例：全局最多同时接收/解码两张，接收租约 15 分钟，未提交批次 24 小时过期。启动时把上次中断的 receiving 项标为可重试失败；不自动提交照片。取消只清除该批次未发布的系统副本，删除失败及崩溃遗留文件待 T10 清理；不要手动清空原图目录。

T05 新增 `GET /albums/{album_id}/photos` 和 `GET /photos/{photo_id}`，均在 `/api/v1` 下。照片分页默认 24、最多 100，签名游标绑定账号、影集、影集版本和上次位置；数据变化返回 409/ALBUM_CHANGED，不能拼接旧页。详情提供同影集的前后照片、序号及只读文字，可附 album_id、expected_album_revision 检查浏览上下文。权限、版本、数量和资料来自同一数据库读取快照，不含存储键、完整哈希或其他账号数据。见 [T05 记录](../docs/t05-browsing-verification.md)。

T06 新增 `GET /api/v1/imports/queue/{queue_id}?after=-1`：按当前账号和随机队列 UUID 查询已登记批次，每页最多 25 批。已有 Idempotency-Key 使用 `<队列 UUID>_<六位批次顺序>`；不另建上传通道或表。返回 `items, next_index`，每个批次追加 `queue_index, city_id, year`，包括可显式取消清理的过期状态，不输出路径或哈希。批量前端继续使用原逐文件接收和显式提交协议；见 [T06 记录](../docs/t06-batch-import-verification.md)。

T07 新增 `PATCH /api/v1/photos/{photo_id}/note` 和 `POST /api/v1/albums/{album_id}/reorder`。文字最多 2000 个 Unicode 字符、可空，JSON 实际字节上限 64 KiB；只改变照片 revision。排序 JSON 上限 16 KiB，在完整有效影集内按照片/锚点移动，两阶段位置更新和影集 revision 处于同一事务；不改照片 ID、文字、revision 或原图。均要求本人资源、CSRF 和匹配版本，冲突返回 409，相同内容/位置不增加版本。复用现有表，无新依赖或迁移；详见 [接口契约](../docs/data-api-design.md) 和 [T07 记录](../docs/t07-editing-verification.md)。

```powershell
uv run ruff check .
uv run python -m pytest -q
```

测试只用临时数据库。`test_process_restart.py` 会在临时端口启动并停止真实 Uvicorn；前端 `npm run test:e2e` 调用 `tests/serve_e2e.py`，在临时数据目录验证实际 Edge。

若本机应用程序控制阻止 `pytest.exe` 启动器，使用上述模块入口或 `.\.venv\Scripts\python.exe -m pytest -q`；不需要重装依赖或更改系统策略。
