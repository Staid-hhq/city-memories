# 城影记后端

FastAPI、SQLAlchemy 与 Alembic 工程。开发命令统一从本目录运行，依赖由 `uv.lock` 锁定。

目录采用标准 Python `src` 布局：`src/city_memories/` 按业务模块组织服务，`migrations/` 保存数据库升级历史，`tests/` 放隔离测试。现有模块规模仍适合这种结构，未为分类新增多层空包；各文件职责见[文件导航](../docs/file-guide.md#后端)。当前开发和维护命令保持不变。

日常本地第一版的启动/停止、构建版前端、配置、数据位置与维护说明集中在 [T16 使用手册](../docs/guides/local-first-release.md)。下面保留开发模式命令；日常无需 `--reload`，不要与既有后端同时运行。

```powershell
uv sync --locked --python 'D:\SDK\Python\Python3.13\python.exe'
uv run python -m alembic upgrade head
uv run uvicorn city_memories.main:app --reload --host 127.0.0.1 --port 8000 --no-proxy-headers
```

只运行单个应用实例。`--no-proxy-headers` 保证限流根据真实连接来源计数，客户端不能伪造 `X-Forwarded-For` 换地址；未来部署的代理信任范围另在 T17 配置。

配置取自项目根目录 `.env` 或 `CITY_MEMORIES_` 环境变量，示例见 [.env.example](.env.example)。默认目录为项目根目录 `.local-data`：`database/` 保存 SQLite，`originals/` 保存独立原图副本，`staging/` 保存待提交图片；`auth-secret.key` 在第一次启动时随机创建，之后重启沿用。不要把这些内容提交到公开仓库。

`/api/v1/auth/csrf`、`register`、`login`、`me`、`logout` 已实现。修改请求必须携带当前会话 Cookie、可信的 Origin/Referer 和 `X-CSRF-Token`；密码、Token、数据库路径不出现在错误响应里。OpenAPI 由运行服务的 `/docs` 提供。

T03 新增 `/api/v1/cities`、`/me/atlas`、`/cities/{city_id}/albums`（GET/POST）和 `/albums/{album_id}`；均要求登录，具体影集必须属于会话本人。迁移 `b61e24f803a7` 加入三个公共城市映射，详情和已测边界见 [T03 记录](../docs/reports/t03-albums-verification.md)。年份为严格整数 1–9999 或 null，重复创建返回原影集；城市与年份列表有签名游标分页，不能用私人游标跨账号读取。

T04 新增创建导入、逐文件接收、状态查询、提交和取消，以及 `/photos/{photo_id}/original`。沿用现有表和依赖，不新增迁移。先校验权限再读取 multipart；实际格式、大小、像素和 SHA256 均由服务端核验。原始字节不重编码，文件先就绪、照片记录和幂等收据再通过短事务一起保存。详细请求格式、50 MiB/8000 万像素限制、租约和失败恢复边界见 [接口契约](../docs/architecture/data-api-design.md#6-导入协议与失败恢复) 与 [T04 记录](../docs/reports/t04-originals-verification.md)。

当前仅支持单实例：全局最多同时接收/解码两张，接收租约 15 分钟，未提交批次 24 小时过期。启动时把上次中断的 receiving 项标为可重试失败；不自动提交照片。取消只清除该批次未发布的系统副本，删除失败及崩溃遗留文件由 T10 后台重试清理；不要手动清空原图目录。

T05 新增 `GET /albums/{album_id}/photos` 和 `GET /photos/{photo_id}`，均在 `/api/v1` 下。照片分页默认 24、最多 100，签名游标绑定账号、影集、影集版本和上次位置；数据变化返回 409/ALBUM_CHANGED，不能拼接旧页。详情提供同影集的前后照片、序号及只读文字，可附 album_id、expected_album_revision 检查浏览上下文。权限、版本、数量和资料来自同一数据库读取快照，不含存储键、完整哈希或其他账号数据。见 [T05 记录](../docs/reports/t05-browsing-verification.md)。

T06 新增 `GET /api/v1/imports/queue/{queue_id}?after=-1`：按当前账号和随机队列 UUID 查询已登记批次，每页最多 25 批。已有 Idempotency-Key 使用 `<队列 UUID>_<六位批次顺序>`；不另建上传通道或表。返回 `items, next_index`，每个批次追加 `queue_index, city_id, year`，包括可显式取消清理的过期状态，不输出路径或哈希。批量前端继续使用原逐文件接收和显式提交协议；见 [T06 记录](../docs/reports/t06-batch-import-verification.md)。

T07 新增 `PATCH /api/v1/photos/{photo_id}/note` 和 `POST /api/v1/albums/{album_id}/reorder`。文字最多 2000 个 Unicode 字符、可空，JSON 实际字节上限 64 KiB；只改变照片 revision。排序 JSON 上限 16 KiB，在完整有效影集内按照片/锚点移动，两阶段位置更新和影集 revision 处于同一事务；不改照片 ID、文字、revision 或原图。均要求本人资源、CSRF 和匹配版本，冲突返回 409，相同内容/位置不增加版本。复用现有表，无新依赖或迁移；详见 [接口契约](../docs/architecture/data-api-design.md) 和 [T07 记录](../docs/reports/t07-editing-verification.md)。

T08 新增 `POST /api/v1/photos/{photo_id}/move` 和 `GET /api/v1/albums/{album_id}/duplicates`。移动要求本人有效照片与本人源/目标影集，以及照片、源影集、目标影集的三个版本；JSON 上限 16 KiB，事务内追加目标末尾并更新三者版本，原 ID、文字、原图和导入收据不变。重复查询仅按本影集有效照片的 SHA256 分组，默认 24、最多 100 **条照片**，大组可跨页，返回代表照片 UUID 而非哈希；游标绑定账号、影集、版本。原影集移空仍保留，相同内容不自动删除或合并；无新依赖或迁移。详见 [T08 记录](../docs/reports/t08-organizing-verification.md)。

```powershell
uv run ruff check .
uv run python -m pytest -q
```

测试只用临时数据库。`test_process_restart.py` 会在临时端口启动并停止真实 Uvicorn；前端 `npm run test:e2e` 调用 `tests/serve_e2e.py`，在临时数据目录验证实际 Edge。

若本机应用程序控制阻止 `pytest.exe` 启动器，使用上述模块入口或 `.\.venv\Scripts\python.exe -m pytest -q`；不需要重装依赖或更改系统策略。

## T09 回收站与恢复

新增 `POST /api/v1/photos/{id}/trash`、`GET /api/v1/trash/photos`、`GET /api/v1/trash/photos/{id}`、`GET /api/v1/trash/photos/{id}/original`、`POST /api/v1/trash/photos/{id}/restore`。修改需照片/影集版本与 CSRF，JSON 16 KiB；写锁后检查归属、状态、版本与时间，两者同事务更新。30×24 小时内可查看并恢复到删除时所在影集末尾，保留原字节/文字/ID，空影集保留；期限相等或 purging 返回 410。分页默认 24、最多 100，游标绑定账号和未到期成员 ID/版本摘要；日期用 Unix 毫秒整数，剩余时长用毫秒。无新依赖/迁移。到期物理清理由下述 T10 实现；记录已清除后再次查询返回 404，不恢复也不重建。见 [T09 记录](../docs/reports/t09-trash-verification.md)。

## T10 到期清理及故障恢复

T10 交付时沿用既有表、依赖和迁移头 `b61e24f803a7`；当前 API 版本仍为 0.13.0，第二版数据库升级见文末 V2-01。没有新增清理按钮或对外清理接口，默认启动补做一轮，再在后台每轮结束后等待 60 秒。无需预先创建计划任务或填写清理密钥。**升级后下次启动真实服务就会清理已到期副本；开发验证只使用临时目录，没有清理用户真实资料。**

配置取自根目录 `.env` 或环境变量：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `CITY_MEMORIES_CLEANUP_ENABLED` | `true` | 启动与周期清理开关；故障排查时可临时设为 false，重启生效 |
| `CITY_MEMORIES_CLEANUP_INTERVAL_SECONDS` | `60` | 两轮之间的等待秒数，整数 1–3600 |

关闭清理不延长回收站/上传期限，不关闭访问校验、启动时 receiving 中断标记或单实例保护。排障后恢复 true 并重启，遗留状态会继续补做；不要把长期关闭当作备份。服务未运行、积压或删除失败时，不保证到期瞬间释放磁盘。

同一私有数据目录使用操作系统文件锁 `maintenance.lock`，第二个实例启动会明确失败；不要用多个 Uvicorn workers。锁文件保留是正常的，关闭或进程崩溃后系统释放锁，**不要在运行时手工删除锁文件**。私有目录必须是独立本地目录，不支持符号链接、Windows junction 或被重定向的祖先目录。

清理顺序：到期照片先事务落库为 purging → 删除该份独立文件 → 删除照片行。文件被占用/权限失败保留状态，下轮重试；文件已删而数据库提交失败时，重启也能完成余下步骤。已成功恢复的照片不会进入 purging；purging 不可恢复。有效照片、未到期回收站、空影集、其他重复副本、上传源文件及历史备份不由此删除。已提交导入收据保留，重放不重新生成已永久清除的照片。

上传租约到期撤销旧尝试；multipart 等待超时释放接收名额，迟到上传不能覆盖新尝试。取消/过期/部分保存放弃项的遗留系统文件可回收；仍在有效批次中的 staged 文件及数据库失败后已发布的副本保留供显式重试。无元数据的系统命名文件至少等待文件修改时间满 24 小时。仅扫描私有目录直接子文件，拒绝硬链接、符号链接、junction，不递归或处理未知命名文件。清理不自动提交导入、不删除批次及幂等收据。

日志只给汇总计数，不输出异常文本、文件名、路径、账号或密钥。若持续出现 `Private-data cleanup incomplete; will retry`，先检查磁盘空间、目录权限和文件占用；解除故障后等待下一轮，必要时正常停止并重启服务。不要手动清空 originals、改库或延长期限；数据损坏/丢失不保证自动恢复，独立备份与恢复工具已在下述 T11 提供。

每轮数据库变更和文件检查有数量上限；目录名称仍会完整枚举排序。T15 已用 3400 份有效合成原图执行 30 轮清理核对，未测数千份过期积压的删除性能。详见 [T10 交付记录](../docs/reports/t10-cleanup-verification.md) 与 [T15 规模记录](../docs/reports/t15-scale-verification.md)。

## T11 一致备份与恢复工具

新增离线模块 `python -m city_memories.backup`，含 `create`、`verify`、`restore`，无网页入口。**先正常停止后端和重载进程**，工具以同一操作系统锁排除应用、清理、迁移和其他维护命令；使用 SQLite Backup API 读取已提交 WAL，不直接复制运行中的单个数据库文件。

`create --data-dir <私有数据目录> --destination <全新备份目录>` 创建快照、复制有效/未到期回收站独立原图、保存清单并完整校验；只整理快照副本，不改源库。清单含格式/迁移版本、大小、哈希、数量和照片元数据摘要。已提交收据保持；旧会话/限流不携带，未提交批次在副本中关闭，暂存文件和认证密钥不复制。

`verify --backup <备份目录>` 校验结构、版本、数据库完整性/外键、清单和全部原图。`restore --backup <备份目录> --destination <全新数据目录>` 先校验再恢复，结束前重新核对到期状态，期限不重置；旧 Cookie 失效，用户名/密码保留。失败目录保留 `.maintenance-incomplete`，不能启动或迁移；完整备份目录也禁止直接作为服务数据目录使用。

目标父目录须存在，最终目录必须不存在、位于 Git 工作区外且与来源不互相包含；不覆盖、不合并、不递归删除任何目录，拒绝链接/网络路径。操作日志只有汇总计数和固定错误，不输出私人字段。备份本身仍含照片、文字、账号及密码哈希，须保密；不内置加密，不自动判断物理介质独立性，不创建定时任务或删除旧备份。

备份格式保持 v1；V2-01 工具兼容旧迁移 `b61e24f803a7` 和新迁移 `c7e9a162b4d8` 的创建、校验与恢复，保留源 schema，不自动升级备份或恢复结果。旧版本恢复目录在启动新版应用前须显式执行 Alembic 升级；不要在备份目录本身迁移。实际使用时的独立介质、频率和保留策略仍需确定。完整命令与升级顺序见 [操作说明](../docs/guides/backup-restore.md)；T11 的历史结果见 [T11 交付记录](../docs/reports/t11-backup-verification.md)，本轮兼容验证见 [V2-01 记录](../docs/reports/2026-10-21-v2-album-library.md)。

## T13 第一版地图配置与城市目录

本节保留第一版在线地图配置。V2-02/V2-03 的正式前端已改用随应用提供的公共市界，不再请求 `/map/config` 或在线瓦片；无需为新图填写 Key。城市业务目录、稳定 UUID 和 `/me/atlas` 的本人统计继续复用，不新增数据库迁移。数据来源及当前验证见[中国地图记录](../docs/reports/2026-10-22-china-city-map.md)。

新增登录必需的 `GET /api/v1/map/cities`（已审核业务身份及供应商代码）和同源 `GET /api/v1/map/config`（绘图 Key、来源信息及可用状态），均不缓存。没有服务器瓦片代理；本人照片统计仍用 `/me/atlas`。391 项开放、草湖市 1 项 pending；启动只补缺，保留原三城 UUID 和所有已有停用/人工修订记录，不改影集归属。

根目录私有 `.env` 或环境变量可设置 `CITY_MEMORIES_MAP_KEY`；也可设置 `CITY_MEMORIES_MAP_KEY_FILE`，指向含 `TIANDITU_KEY=占位符` 的受保护本地配置文件。不要同时复制真实值到源码。另需 `CITY_MEMORIES_MAP_REVIEW_NUMBER`、`CITY_MEMORIES_MAP_REVIEW_DATE`，由官方实际服务核对后配置；缺失则只使用文字入口。本机已引用现有 Key 文件，仓库只提供 `.env.example`。

浏览器 Key 对已登录浏览器可见，上线须复核域名限制和使用条件；此接口不是保护服务端秘密的通用渠道。配置错误不会在响应中回显 Key 或文件路径。详见 [T13 交付](../docs/reports/t13-map-verification.md)、[目录审核](../docs/reference/t13-city-catalog.md)。后端全量 257 项及 Ruff 通过，无新增迁移或依赖。

## V2-01 独立相册与封面偏好

新增 `GET /api/v1/me/albums`，返回本人跨城市的 `{items, next_cursor}` 相册列表，分页默认 24、最多 100，按年份倒序、未标年份最后，同年按稳定 ID 排列；签名游标绑定当前账号。各项沿用 `AlbumView`，有效照片数量与封面按本人资源计算。

新增 `PATCH /api/v1/albums/{id}/cover`，JSON 为 `{photo_id: null|string, expected_revision: int}`，成功返回更新后的 `AlbumView`。修改需要当前会话、CSRF 和本人影集；手选照片须仍属于该影集且有效，版本不匹配返回 `409 / ALBUM_CHANGED`。`photo_id: null` 恢复自动封面；当前手选照片无效时展示会回退到影集顺序中的第一张有效照片，无有效照片时为空。封面偏好不修改照片 ID、原图字节、文字或顺序。

迁移 `c7e9a162b4d8` 在 `albums` 增加可空的 `preferred_cover_photo_id`，现有行默认 null，使用自动封面。**PyCharm 启动入口不会自动迁移。** 先正常停机、核对数据目录并备份，再从 `backend` 目录由使用者执行：

```powershell
& .\.venv\Scripts\python.exe -m alembic upgrade head
if ($LASTEXITCODE -ne 0) { throw '迁移未完成，不要启动新版服务' }
```

本轮仅升级合成测试库，未读取或迁移真实数据库、照片和 `.env`；依赖与锁文件保持不变。备份工具接受旧/新 schema 并保持源版本；旧库或旧恢复目录启动新版前仍要按上述命令显式升级。实现、验证进度和第二版剩余任务见 [V2-01 记录](../docs/reports/2026-10-21-v2-album-library.md)。
