# 此间集后端

FastAPI、SQLAlchemy 与 Alembic 工程，采用 Python `src` 布局。以下命令从 `backend/` 执行，依赖由 [pyproject.toml](pyproject.toml) 和 `uv.lock` 锁定。日常启动见[本地手册](../docs/guides/local-first-release.md)，接口字段与错误码统一维护在[数据与接口设计](../docs/architecture/data-api-design.md)。

## 环境与启动

首次准备或依赖变化，按[安装与更新步骤](../docs/guides/local-first-release.md#3-新机器首次准备或更新后)同步环境。已有环境时使用项目 Python；本机裸 `python` 可能指向 MSYS2。

确认依赖、实际数据目录和迁移就绪后，使用与 PyCharm 共享配置一致的命令：

```powershell
& .\.venv\Scripts\python.exe -m uvicorn city_memories.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers --no-access-log
```

只运行一个应用实例，不加多 `workers`。日常不需要 `--reload`；后端代码变更后正常停止并重启。`--no-proxy-headers` 保留真实连接来源的限流口径，未来部署的代理信任范围另在 T17 配置。

配置来自工程根目录 `.env` 或 `CITY_MEMORIES_` 环境变量，环境变量优先；[.env.example](.env.example) 仅有占位示例。默认数据在根目录 `.local-data/`，配置与数据不提交 GitHub。产品更名未改变包名、环境变量前缀、Cookie、数据库或备份标识。

## 代码职责

| 模块 | 职责 |
| --- | --- |
| [main.py](src/city_memories/main.py)、[config.py](src/city_memories/config.py) | 应用工厂、生命周期与配置 |
| [auth.py](src/city_memories/auth.py)、[boundary.py](src/city_memories/boundary.py)、[errors.py](src/city_memories/errors.py) | 会话、CSRF、来源/频率限制及统一错误边界 |
| [models.py](src/city_memories/models.py)、[database.py](src/city_memories/database.py)、`migrations/` | 数据模型、连接及迁移链 |
| [albums.py](src/city_memories/albums.py)、[province_centers.py](src/city_memories/province_centers.py) | 城市/年份影集、城市聚合、封面和省会视图 |
| [imports.py](src/city_memories/imports.py)、[storage.py](src/city_memories/storage.py) | 导入、暂存、原图存储与恢复状态 |
| [photos.py](src/city_memories/photos.py)、[editing.py](src/city_memories/editing.py)、[organizing.py](src/city_memories/organizing.py) | 原图/分页、文字/排序、移动与重复查看 |
| [trash.py](src/city_memories/trash.py)、[cleanup.py](src/city_memories/cleanup.py)、[backup.py](src/city_memories/backup.py) | 回收恢复、到期/遗留清理与离线备份 |
| [maps.py](src/city_memories/maps.py)、[city-catalog.json](src/city_memories/city-catalog.json) | 已审核城市目录、稳定业务 ID 及第一版地图兼容接口 |
| `tests/` | 临时数据和合成图片的接口/维护/重启测试 |

完整职责见[文件导航](../docs/file-guide.md#后端)。

## 数据库升级

当前迁移头为 `c7e9a162b4d8`。新安装、第一版旧库或旧版恢复目录，需要先停止后端、核对实际目录，有资料时完成一致备份，再显式升级：

```powershell
& .\.venv\Scripts\python.exe -m alembic upgrade head
if ($LASTEXITCODE -ne 0) { throw '迁移未完成，不要启动服务' }
& .\.venv\Scripts\python.exe -m alembic current
```

运行按钮不会迁移；当前头未变时不因普通界面更新重复初始化。迁移会使用当前配置的数据目录，不把备份目录当作运行目录，也不通过删库解决缺字段。恢复后的升级顺序见[备份指南](../docs/guides/backup-restore.md#3-恢复到全新目录并检查)。

## 接口与实现约束

所有业务路径位于 `/api/v1`，OpenAPI 由运行服务的 `/docs` 提供。除健康、注册/登录等必要入口外，私人资源必须检查当前账号归属；修改请求沿用 Cookie、可信 Origin/Referer 和 `X-CSRF-Token`。

- `/me/city-albums` 读取本人按城市聚合的相册；`/cities/{id}/albums` 读取年份影集；`/me/albums` 仍服务最近整理等年份列表。城市聚合不新增表或改变既有照片归属。
- 搜索、年份、排序及游标绑定账号和条件；年份筛选选出城市后，城市卡统计和封面仍覆盖该城市所有年份。
- 导入分为登记、传输/校验与明确提交，重试保持原批次和幂等参数；只有提交成功才进入影集。文件就绪与数据库关系提交须保持一致，原字节不重编码。
- 文字、排序、移动、封面及回收/恢复使用既有版本核对；冲突不覆盖新内容，不以新建操作掩盖结果不明。
- 后端保存城市业务身份和本人统计；当前前端使用公共静态矢量，不请求旧 `/map/config` 或在线瓦片，无需新增地图 Key。

完整协议以[接口契约](../docs/architecture/data-api-design.md)为准，历史实现过程见[报告索引](../docs/reports/README.md)。

## T10 到期清理及故障恢复

默认在启动时补做清理，再在运行中每轮结束等待 60 秒。**启动真实数据目录会按规则永久清理到期副本**；测试必须使用临时目录。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `CITY_MEMORIES_CLEANUP_ENABLED` | `true` | 控制启动及周期清理，改变后重启生效 |
| `CITY_MEMORIES_CLEANUP_INTERVAL_SECONDS` | `60` | 两轮之间等待秒数，整数 1–3600 |

关闭清理不会延长回收站/上传期限，也不取消中断接收状态恢复、访问校验或单实例保护。回收站保留 30×24 小时，到期立即禁止查看/恢复，物理删除失败留待重试。

清理协调未提交/过期导入、遗留临时文件、到期回收站、会话及限流资料；保留已提交导入的幂等收据，永久删除照片后也不能因重放旧请求重新生成。实例锁在关闭清理时仍保留，不手动删除锁文件。日志仅输出固定错误和汇总，不输出密钥、私人内容或完整异常；服务停机、积压或故障时不保证准点释放空间。

排障先核对磁盘、权限和占用，解除后重试；不手工清空 `originals/`、`staging/` 或修改数据库。完整规则与边界见[数据设计](../docs/architecture/data-api-design.md)及[历史验证](../docs/reports/v1/t10-cleanup-verification.md)。

## 离线备份与恢复

`python -m city_memories.backup` 提供 `create`、`verify`、`restore`，没有网页入口。使用项目 Python，先正常停止后端，再按[备份指南](../docs/guides/backup-restore.md)选择实际数据目录、工作区外全新目标并校验。

备份保留有效照片和未到期回收站，不携带 `.env`、认证密钥或旧会话；恢复保留账号密码哈希、原图、关系、文字和顺序，期限不重置。工具接受第一版和当前迁移版本并保留源 schema，不自动升级恢复结果。不覆盖或合并旧资料，不内置加密、定时任务或自动轮换。

## 测试与检查

已有项目环境时执行：

```powershell
& .\.venv\Scripts\python.exe -m ruff check .
& .\.venv\Scripts\python.exe -m pytest -q
```

测试使用临时数据库；`test_process_restart.py` 会在临时端口启动真实 Uvicorn。`tests/serve_e2e.py` 仅供前端隔离回归，不能用作日常服务入口。前端测试和独立端口说明见[前端 README](../frontend/README.md#隔离测试)。

已有可用环境无需为运行测试重装全局包；使用模块入口可避开某些环境对 `pytest.exe` 包装器的限制。结果、截图和运行库留在忽略目录，实际通过项及未测范围只记录在对应交付报告中。
