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

当前仅支持单实例：全局最多同时接收/解码两张，接收租约 15 分钟，未提交批次 24 小时过期。启动时把上次中断的 receiving 项标为可重试失败；不自动提交照片。取消只清除该批次未发布的系统副本，删除失败及崩溃遗留文件由 T10 后台重试清理；不要手动清空原图目录。

T05 新增 `GET /albums/{album_id}/photos` 和 `GET /photos/{photo_id}`，均在 `/api/v1` 下。照片分页默认 24、最多 100，签名游标绑定账号、影集、影集版本和上次位置；数据变化返回 409/ALBUM_CHANGED，不能拼接旧页。详情提供同影集的前后照片、序号及只读文字，可附 album_id、expected_album_revision 检查浏览上下文。权限、版本、数量和资料来自同一数据库读取快照，不含存储键、完整哈希或其他账号数据。见 [T05 记录](../docs/t05-browsing-verification.md)。

T06 新增 `GET /api/v1/imports/queue/{queue_id}?after=-1`：按当前账号和随机队列 UUID 查询已登记批次，每页最多 25 批。已有 Idempotency-Key 使用 `<队列 UUID>_<六位批次顺序>`；不另建上传通道或表。返回 `items, next_index`，每个批次追加 `queue_index, city_id, year`，包括可显式取消清理的过期状态，不输出路径或哈希。批量前端继续使用原逐文件接收和显式提交协议；见 [T06 记录](../docs/t06-batch-import-verification.md)。

T07 新增 `PATCH /api/v1/photos/{photo_id}/note` 和 `POST /api/v1/albums/{album_id}/reorder`。文字最多 2000 个 Unicode 字符、可空，JSON 实际字节上限 64 KiB；只改变照片 revision。排序 JSON 上限 16 KiB，在完整有效影集内按照片/锚点移动，两阶段位置更新和影集 revision 处于同一事务；不改照片 ID、文字、revision 或原图。均要求本人资源、CSRF 和匹配版本，冲突返回 409，相同内容/位置不增加版本。复用现有表，无新依赖或迁移；详见 [接口契约](../docs/data-api-design.md) 和 [T07 记录](../docs/t07-editing-verification.md)。

T08 新增 `POST /api/v1/photos/{photo_id}/move` 和 `GET /api/v1/albums/{album_id}/duplicates`。移动要求本人有效照片与本人源/目标影集，以及照片、源影集、目标影集的三个版本；JSON 上限 16 KiB，事务内追加目标末尾并更新三者版本，原 ID、文字、原图和导入收据不变。重复查询仅按本影集有效照片的 SHA256 分组，默认 24、最多 100 **条照片**，大组可跨页，返回代表照片 UUID 而非哈希；游标绑定账号、影集、版本。原影集移空仍保留，相同内容不自动删除或合并；无新依赖或迁移。详见 [T08 记录](../docs/t08-organizing-verification.md)。

```powershell
uv run ruff check .
uv run python -m pytest -q
```

测试只用临时数据库。`test_process_restart.py` 会在临时端口启动并停止真实 Uvicorn；前端 `npm run test:e2e` 调用 `tests/serve_e2e.py`，在临时数据目录验证实际 Edge。

若本机应用程序控制阻止 `pytest.exe` 启动器，使用上述模块入口或 `.\.venv\Scripts\python.exe -m pytest -q`；不需要重装依赖或更改系统策略。

## T09 回收站与恢复

新增 `POST /api/v1/photos/{id}/trash`、`GET /api/v1/trash/photos`、`GET /api/v1/trash/photos/{id}`、`GET /api/v1/trash/photos/{id}/original`、`POST /api/v1/trash/photos/{id}/restore`。修改需照片/影集版本与 CSRF，JSON 16 KiB；写锁后检查归属、状态、版本与时间，两者同事务更新。30×24 小时内可查看并恢复到删除时所在影集末尾，保留原字节/文字/ID，空影集保留；期限相等或 purging 返回 410。分页默认 24、最多 100，游标绑定账号和未到期成员 ID/版本摘要；日期用 Unix 毫秒整数，剩余时长用毫秒。无新依赖/迁移。到期物理清理由下述 T10 实现；记录已清除后再次查询返回 404，不恢复也不重建。见 [T09 记录](../docs/t09-trash-verification.md)。

## T10 到期清理及故障恢复

当前 API 版本 0.10.0，复用既有表、依赖和迁移头 `b61e24f803a7`。不新增清理按钮或对外清理接口，默认启动补做一轮，再在后台每轮结束后等待 60 秒。无需预先创建计划任务或填写密钥。**升级后下次启动真实服务就会清理已到期副本；开发验证只使用临时目录，没有清理用户真实资料。**

配置取自根目录 `.env` 或环境变量：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `CITY_MEMORIES_CLEANUP_ENABLED` | `true` | 启动与周期清理开关；故障排查时可临时设为 false，重启生效 |
| `CITY_MEMORIES_CLEANUP_INTERVAL_SECONDS` | `60` | 两轮之间的等待秒数，整数 1–3600 |

关闭清理不延长回收站/上传期限，不关闭访问校验、启动时 receiving 中断标记或单实例保护。排障后恢复 true 并重启，遗留状态会继续补做；不要把长期关闭当作备份。服务未运行、积压或删除失败时，不保证到期瞬间释放磁盘。

同一私有数据目录使用操作系统文件锁 `maintenance.lock`，第二个实例启动会明确失败；不要用多个 Uvicorn workers。锁文件保留是正常的，关闭或进程崩溃后系统释放锁，**不要在运行时手工删除锁文件**。私有目录必须是独立本地目录，不支持符号链接、Windows junction 或被重定向的祖先目录。

清理顺序：到期照片先事务落库为 purging → 删除该份独立文件 → 删除照片行。文件被占用/权限失败保留状态，下轮重试；文件已删而数据库提交失败时，重启也能完成余下步骤。已成功恢复的照片不会进入 purging；purging 不可恢复。有效照片、未到期回收站、空影集、其他重复副本、上传源文件及历史备份不由此删除。已提交导入收据保留，重放不重新生成已永久清除的照片。

上传租约到期撤销旧尝试；multipart 等待超时释放接收名额，迟到上传不能覆盖新尝试。取消/过期/部分保存放弃项的遗留系统文件可回收；仍在有效批次中的 staged 文件及数据库失败后已发布的副本保留供显式重试。无元数据的系统命名文件至少等待文件修改时间满 24 小时。仅扫描私有目录直接子文件，拒绝硬链接、符号链接、junction，不递归或处理未知命名文件。清理不自动提交导入、不删除批次及幂等收据。

日志只给汇总计数，不输出异常文本、文件名、路径、账号或密钥。若持续出现 `Private-data cleanup incomplete; will retry`，先检查磁盘空间、目录权限和文件占用；解除故障后等待下一轮，必要时正常停止并重启服务。不要手动清空 originals、改库或延长期限；数据损坏/丢失不保证自动恢复，独立备份与恢复工具属于 T11。

每轮数据库变更和文件检查有数量上限；目录名称仍会完整枚举排序，不代表通过大目录性能验收。详见 [T10 交付记录](../docs/t10-cleanup-verification.md)，400/3000 规模留待 T15。
