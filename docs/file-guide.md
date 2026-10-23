# 仓库文件导航

更新：2026-10-23。本页逐项说明 Git 管理的源码、文档、测试与配置；目录路径均相对于仓库根目录。点击文件名可打开对应文件。

先记住：`frontend` 是页面、`backend` 是服务、`docs` 是说明、`validation` 是专项测试、`prototype` 是历史原型。日常启动看[使用手册](guides/local-first-release.md)，不用逐一打开下面所有文件。

## 根目录与维护工具

| 文件 | 用途 |
| --- | --- |
| [README.md](../README.md) | 项目首页、当前状态、启动入口和目录导航 |
| [AGENTS.md](../AGENTS.md) | 协作约定、提交推送规则和隐私边界 |
| [.gitignore](../.gitignore) | 防止密钥、私人数据、缓存、构建和测试产物入库 |
| [.gitattributes](../.gitattributes) | 固定公共地图资产的 LF 换行，保持 Windows 检出与生成校验一致 |
| [.run/local.run.xml](../.run/local.run.xml) | PyCharm 日常入口，同时运行前端和后端 |
| [.run/backend.run.xml](../.run/backend.run.xml) | 用项目虚拟环境运行后端，不复制密钥或自动迁移 |
| [.run/frontend.run.xml](../.run/frontend.run.xml) | npm 构建预览，固定本机 5173 端口 |
| [.run/build.run.xml](../.run/build.run.xml) | 修改前端后执行类型检查与构建 |
| [scripts/check-repository.mjs](../scripts/check-repository.mjs) | 只读检查文档文件链接、逐文件导航覆盖和本地模块导入 |
| [scripts/build-china-map-data.py](../scripts/build-china-map-data.py) | 从固定公开源校验并生成中国市级矢量及独立省界线，只用标准库，不读私人资料 |

## 前端

以下表格的路径相对于 `frontend/`。

### 入口与配置

| 文件 | 用途 |
| --- | --- |
| [README.md](../frontend/README.md) | 前端结构、开发命令和测试分区说明 |
| [package.json](../frontend/package.json) | npm 命令和直接依赖版本 |
| [package-lock.json](../frontend/package-lock.json) | 固定完整 npm 依赖树，安装时使用，不手改 |
| [index.html](../frontend/index.html) | 网页 HTML 外壳及 React 挂载节点 |
| [vite.config.ts](../frontend/vite.config.ts) | 开发/构建配置、本地 API 代理、有界连接池及独立测试后端端口 |
| [eslint.config.js](../frontend/eslint.config.js) | TypeScript、React Hooks 等静态检查规则 |
| [tsconfig.json](../frontend/tsconfig.json) | TypeScript 项目引用入口 |
| [tsconfig.app.json](../frontend/tsconfig.app.json) | 浏览器应用代码的类型检查设置 |
| [tsconfig.node.json](../frontend/tsconfig.node.json) | Vite 配置的 Node 环境类型检查设置 |
| [playwright.config.ts](../frontend/playwright.config.ts) | 默认 Edge 测试及隔离服务配置，可覆盖测试端口避开日常实例 |
| [playwright.delivery.config.ts](../frontend/playwright.delivery.config.ts) | 构建版空库验收及独立测试端口，复用连续流程 |
| [playwright.scale.config.ts](../frontend/playwright.scale.config.ts) | 显式启用的重量级规模测试配置 |
| [scripts/test-e2e.mjs](../frontend/scripts/test-e2e.mjs) | 默认既有业务/地图/连续流程/首页与相册四组运行，各自重建隔离服务 |
| [scripts/test-scale.mjs](../frontend/scripts/test-scale.mjs) | 先规模浏览器测试，再执行离线维护与哈希审计 |

### 公共地图资产

| 文件 | 用途 |
| --- | --- |
| [public/map-data/china-cities.v1.json](../frontend/public/map-data/china-cities.v1.json) | 391 个已审核入口的公共市界、独立省界、背景与源国界/海岸/南海线，无私人统计 |
| [public/map-data/NOTICE.md](../frontend/public/map-data/NOTICE.md) | 地图来源、固定版本、处理方式与复现入口 |
| [public/map-data/LICENSES.txt](../frontend/public/map-data/LICENSES.txt) | 随公共地图分发的 GeoCode-Release 与 taiwan-atlas MIT 许可文本 |

### 应用与业务代码

| 文件 | 用途 |
| --- | --- |
| [src/main.tsx](../frontend/src/main.tsx) | 创建 React 根节点和 Router，加载全局样式 |
| [src/vite-env.d.ts](../frontend/src/vite-env.d.ts) | Vite 客户端的 TypeScript 类型声明 |
| [src/app/App.tsx](../frontend/src/app/App.tsx) | 注册/登录、启动连接帮助、会话手动核对、退出清理和顶层路由 |
| [src/shared/api.ts](../frontend/src/shared/api.ts) | HTTP 请求及响应状态分类、错误翻译、CSRF、账号切换隔离、上传及原图字节读取 |
| [src/shared/OperationFeedback.tsx](../frontend/src/shared/OperationFeedback.tsx) | 页面内持续的操作进度、成功、警示及失败反馈，含无障碍状态和就近操作 |
| [src/styles/global.css](../frontend/src/styles/global.css) | 白色界面、导航、封面卡与功能样式；含手机触控控件、局部横滚和短屏查看层 |
| [src/features/albums/Journal.tsx](../frontend/src/features/albums/Journal.tsx) | 登录后的导航外壳、城市搜索、年份影集、相册入口与地图联动 |
| [src/features/albums/AlbumLibrary.tsx](../frontend/src/features/albums/AlbumLibrary.tsx) | 本人相册筛选、排序分页、条件/返回位置记忆；与城市年份页共用 3:4 封面、完整城市名和对齐资料的卡片 |
| [src/features/albums/HomeSidebar.tsx](../frontend/src/features/albums/HomeSidebar.tsx) | 首页本人足迹统计、最近三本相册及相册/选城快捷入口 |
| [src/features/albums/types.ts](../frontend/src/features/albums/types.ts) | 城市、影集和个人地图统计类型，不依赖页面组件 |
| [src/features/imports/UploadPanel.tsx](../frontend/src/features/imports/UploadPanel.tsx) | 单张原图上传、校验、确认保存与失败状态 |
| [src/features/imports/BatchImport.tsx](../frontend/src/features/imports/BatchImport.tsx) | 批量导入页面、任务执行、重选、重试和恢复查询；提供待确认列表横滚提示并保留返回来源 |
| [src/features/imports/importQueue.ts](../frontend/src/features/imports/importQueue.ts) | 文件编号/年份解析、批次拆分、队列数据和提交规则 |
| [src/features/photos/PhotoGallery.tsx](../frontend/src/features/photos/PhotoGallery.tsx) | 照片分页、手机短屏查看层及完整文件名、前后浏览、排序与封面选择 |
| [src/features/photos/OriginalImage.tsx](../frontend/src/features/photos/OriginalImage.tsx) | 视野附近按需取原图，取消请求和释放 Blob URL/图片资源 |
| [src/features/photos/NoteEditor.tsx](../frontend/src/features/photos/NoteEditor.tsx) | 照片文字编辑、草稿离开提醒和版本冲突处理 |
| [src/features/photos/MovePhoto.tsx](../frontend/src/features/photos/MovePhoto.tsx) | 目标城市/年份选择、创建目标影集、确认跨影集移动 |
| [src/features/photos/Duplicates.tsx](../frontend/src/features/photos/Duplicates.tsx) | 本影集同内容照片的分组分页与逐份查看，不自动删除 |
| [src/features/photos/photos.ts](../frontend/src/features/photos/photos.ts) | 照片、文字、分页和详情的 TypeScript 数据类型 |
| [src/features/map/CityMap.tsx](../frontend/src/features/map/CityMap.tsx) | 中国全市级 SVG、省市边界层级、南海附图、本人点亮、定位、拖缩和返回视角；触摸滚页与显式移动地图切换 |
| [src/features/map/mapGeometry.ts](../frontend/src/features/map/mapGeometry.ts) | 投影、WKT 边界解析、几何路径、坐标和瓦片范围计算 |
| [src/features/map/mapService.ts](../frontend/src/features/map/mapService.ts) | 静态市界加载、严格身份关联、缓存/取消/失败处理；保留第一版行政请求兼容方法 |
| [src/features/trash/Trash.tsx](../frontend/src/features/trash/Trash.tsx) | 回收站列表、照片删除确认、原图查看和恢复流程 |

### 测试

| 文件 | 用途 |
| --- | --- |
| [tests/e2e/auth.spec.ts](../frontend/tests/e2e/auth.spec.ts) | 注册/登录/退出、启动异常与超时重连、会话核对、草稿和权限隔离 |
| [tests/e2e/albums.spec.ts](../frontend/tests/e2e/albums.spec.ts) | 城市搜索、空影集、年份和账号隔离 |
| [tests/e2e/library.spec.ts](../frontend/tests/e2e/library.spec.ts) | 独立相册分页/返回、空态/失败/换号隔离、跨页封面选择和冲突核对 |
| [tests/e2e/library-filters.spec.ts](../frontend/tests/e2e/library-filters.spec.ts) | 相册组合筛选/排序、完整年份选项、分页返回及失败/迟到请求/账号隔离 |
| [tests/e2e/home-sidebar.spec.ts](../frontend/tests/e2e/home-sidebar.spec.ts) | 首页双栏/窄屏、本人统计和最近相册、错误/空态/换号及刷新联动 |
| [tests/e2e/uploads.spec.ts](../frontend/tests/e2e/uploads.spec.ts) | 单图校验、保存、取消、失败和原字节核对 |
| [tests/e2e/photos.spec.ts](../frontend/tests/e2e/photos.spec.ts) | 分页、按需原图、查看层、返回位置和授权 |
| [tests/e2e/batches.spec.ts](../frontend/tests/e2e/batches.spec.ts) | 队列纯规则与批量上传、拆批、重试、恢复流程 |
| [tests/e2e/editing.spec.ts](../frontend/tests/e2e/editing.spec.ts) | 文字草稿、冲突、离开提醒、拖动和跨页排序 |
| [tests/e2e/organizing.spec.ts](../frontend/tests/e2e/organizing.spec.ts) | 跨影集移动、重复分组及错误恢复 |
| [tests/e2e/trash.spec.ts](../frontend/tests/e2e/trash.spec.ts) | 删除确认、回收站、恢复和状态冲突 |
| [tests/e2e/maps.spec.ts](../frontend/tests/e2e/maps.spec.ts) | 静态几何、全市灰底、桌面及触屏滚页/移动交互、本人统计和请求隔离 |
| [tests/e2e/map-service.spec.ts](../frontend/tests/e2e/map-service.spec.ts) | 地图请求调度、复用和错误规则 |
| [tests/e2e/map-live.spec.ts](../frontend/tests/e2e/map-live.spec.ts) | 默认实际公共矢量的 391 项覆盖、零在线地图请求与窄屏检查 |
| [tests/e2e/journey.spec.ts](../frontend/tests/e2e/journey.spec.ts) | 从注册到导入、整理、恢复、重登的连续流程与双账号检查 |
| [tests/delivery/local.spec.ts](../frontend/tests/delivery/local.spec.ts) | 空库、真实构建资源、深链接、代理与端口冲突验收 |
| [tests/scale/scale.spec.ts](../frontend/tests/scale/scale.spec.ts) | 400 张导入、3000 张账号、双账号并发与重复浏览内存 |

## 后端

以下表格的路径相对于 `backend/`。现有 Python 包已经按业务模块分工，本轮保留标准 `src`、`tests`、`migrations` 布局。

### 环境与运行模块

| 文件 | 用途 |
| --- | --- |
| [README.md](../backend/README.md) | 后端启动、接口与维护行为说明 |
| [.env.example](../backend/.env.example) | 可公开的配置示例，实际配置放项目根目录 `.env` |
| [pyproject.toml](../backend/pyproject.toml) | Python 项目、依赖、构建、pytest 和 Ruff 设置 |
| [uv.lock](../backend/uv.lock) | 固定 Python 依赖版本与校验信息，不手改 |
| [alembic.ini](../backend/alembic.ini) | Alembic 迁移工具设置 |
| [src/city_memories/__init__.py](../backend/src/city_memories/__init__.py) | Python 应用包入口声明 |
| [src/city_memories/main.py](../backend/src/city_memories/main.py) | 创建 FastAPI、组装服务/路由、启动与关闭生命周期、健康检查 |
| [src/city_memories/config.py](../backend/src/city_memories/config.py) | 配置读取、默认数据位置和安全校验 |
| [src/city_memories/database.py](../backend/src/city_memories/database.py) | SQLite/SQLAlchemy 连接、事务和外键/WAL 设置 |
| [src/city_memories/models.py](../backend/src/city_memories/models.py) | 数据表 ORM 模型、字段、索引与约束 |
| [src/city_memories/errors.py](../backend/src/city_memories/errors.py) | 统一业务错误及 API 响应格式 |
| [src/city_memories/boundary.py](../backend/src/city_memories/boundary.py) | 请求边界：CSRF、请求体限制、安全缓存头和异常转换 |
| [src/city_memories/auth.py](../backend/src/city_memories/auth.py) | 密码哈希、会话、CSRF、注册登录与限流 |
| [src/city_memories/albums.py](../backend/src/city_memories/albums.py) | 城市/年份影集、本人相册筛选/排序分页及年份选项、封面、统计和签名游标 |
| [src/city_memories/imports.py](../backend/src/city_memories/imports.py) | 导入批次、上传租约、内容接收、幂等提交、取消及队列查询 |
| [src/city_memories/storage.py](../backend/src/city_memories/storage.py) | 私有原图/暂存文件的校验、路径边界与文件操作 |
| [src/city_memories/photos.py](../backend/src/city_memories/photos.py) | 照片详情、分页、前后位置与原图访问授权 |
| [src/city_memories/editing.py](../backend/src/city_memories/editing.py) | 纯文本更新、版本检查和事务内排序 |
| [src/city_memories/organizing.py](../backend/src/city_memories/organizing.py) | 跨影集移动和重复内容分组 |
| [src/city_memories/trash.py](../backend/src/city_memories/trash.py) | 软删除、30 天回收站、恢复和期限检查 |
| [src/city_memories/cleanup.py](../backend/src/city_memories/cleanup.py) | 单实例锁、到期清理、后台循环及失败重试 |
| [src/city_memories/backup.py](../backend/src/city_memories/backup.py) | 离线一致备份、完整性校验与新目录恢复 CLI |
| [src/city_memories/maps.py](../backend/src/city_memories/maps.py) | 正式城市目录校验/补齐与已认证地图配置接口 |
| [src/city_memories/city-catalog.json](../backend/src/city_memories/city-catalog.json) | 公共业务城市目录和映射审核状态，不是用户照片/地点数据 |

### 数据库迁移

| 文件 | 用途 |
| --- | --- |
| [migrations/env.py](../backend/migrations/env.py) | 迁移环境、数据库连接和维护锁保护 |
| [migrations/script.py.mako](../backend/migrations/script.py.mako) | 新迁移文件模板 |
| [migrations/versions/4a097ff7fccb_create_initial_schema.py](../backend/migrations/versions/4a097ff7fccb_create_initial_schema.py) | 首次创建正式数据库结构 |
| [migrations/versions/b61e24f803a7_seed_verified_cities.py](../backend/migrations/versions/b61e24f803a7_seed_verified_cities.py) | 初始已核对城市种子迁移；后续目录补齐由应用负责 |
| [migrations/versions/c7e9a162b4d8_add_album_cover_preference.py](../backend/migrations/versions/c7e9a162b4d8_add_album_cover_preference.py) | 为相册增加可空封面偏好；旧行默认使用自动封面 |

迁移历史不是可随意删除的旧代码；实际数据库结构以迁移与模型为准，不直接执行文档中的 SQL 设计样例覆盖数据库。

### 后端测试

| 文件 | 用途 |
| --- | --- |
| [tests/photo_fixtures.py](../backend/tests/photo_fixtures.py) | 合成照片及导入等共享测试辅助 |
| [tests/serve_e2e.py](../backend/tests/serve_e2e.py) | 为默认 Edge 回归启动隔离数据库与测试服务 |
| [tests/test_database.py](../backend/tests/test_database.py) | 迁移、约束、配置和数据库基础检查 |
| [tests/test_auth.py](../backend/tests/test_auth.py) | 认证、CSRF、限流、授权边界 |
| [tests/test_albums.py](../backend/tests/test_albums.py) | 城市、相册组合筛选/年份选项、封面、稳定分页及游标/账号隔离 |
| [tests/test_imports.py](../backend/tests/test_imports.py) | 原图导入、校验、幂等提交及失败边界 |
| [tests/test_import_queue.py](../backend/tests/test_import_queue.py) | 批量队列状态查询与恢复协议 |
| [tests/test_photos.py](../backend/tests/test_photos.py) | 原图/详情授权、分页和数据变化 |
| [tests/test_editing.py](../backend/tests/test_editing.py) | 文字、排序、并发版本和事务回滚 |
| [tests/test_organizing.py](../backend/tests/test_organizing.py) | 移动、重复分组、并发与回滚 |
| [tests/test_trash.py](../backend/tests/test_trash.py) | 删除/恢复、到期边界和分页授权 |
| [tests/test_cleanup.py](../backend/tests/test_cleanup.py) | 清理、锁、故障重试、文件系统安全及竞争 |
| [tests/test_backup.py](../backend/tests/test_backup.py) | 一致备份、WAL、校验、恢复、路径和故障边界 |
| [tests/test_maps.py](../backend/tests/test_maps.py) | 城市目录门禁、配置和地图 API |
| [tests/test_process_restart.py](../backend/tests/test_process_restart.py) | 真实子进程停止/重启后的持久性与恢复 |

## 文档

以下表格的路径相对于 `docs/`。

| 文件 | 用途 |
| --- | --- |
| [README.md](README.md) | 按阅读目的分类的文档与交付索引 |
| [file-guide.md](file-guide.md) | 当前逐文件职责表及私人/生成文件边界 |
| [guides/local-first-release.md](guides/local-first-release.md) | 本地启动、停止、首次安装、升级、配置和排障 |
| [guides/ide-startup.md](guides/ide-startup.md) | 本机开发软件选择、PyCharm 点选启动/停止与解释器排障 |
| [guides/user-guide.md](guides/user-guide.md) | 地图、导入、浏览、文字、整理、移动、回收站的操作说明 |
| [guides/backup-restore.md](guides/backup-restore.md) | 离线备份、校验、恢复的具体命令及安全条件 |
| [product/project-brief.md](product/project-brief.md) | 产品定位、目标用户、价值与不做的事 |
| [product/requirements.md](product/requirements.md) | 需求、确认口径、验收条件与任务对应 |
| [product/page-flow.md](product/page-flow.md) | 页面设计、交互流程及原型阶段补充 |
| [architecture/tech-stack.md](architecture/tech-stack.md) | 技术选型、组件关系、运行和数据保存方式 |
| [architecture/data-api-design.md](architecture/data-api-design.md) | 数据关系、约束、接口契约和失败恢复协议 |
| [architecture/data-model.sql](architecture/data-model.sql) | 设计阶段 SQL 样例，不是运行数据库或正式迁移入口 |
| [architecture/account-storage-plan.md](architecture/account-storage-plan.md) | 账号隔离、原图存储和备份方案依据 |
| [architecture/map-plan.md](architecture/map-plan.md) | 地图供应商、来源、调用和加载方案依据 |
| [planning/development-plan.md](planning/development-plan.md) | T01–T17 与 V2-01–V2-04 任务进度、依赖和逐项实施记录 |
| [reference/t03-city-mappings.md](reference/t03-city-mappings.md) | 初期三城 UUID/供应商映射与核对依据 |
| [reference/t13-city-catalog.md](reference/t13-city-catalog.md) | 正式目录审核、特殊地区口径和待开放项 |
| [reports/feasibility.md](reports/feasibility.md) | 准备阶段关键可行性验证与限制 |
| [reports/edge-review-2026-09-21.md](reports/edge-review-2026-09-21.md) | 早期原型实际 Edge 操作复查 |
| [reports/t02-auth-verification.md](reports/t02-auth-verification.md) | T02 账号认证交付证据 |
| [reports/t03-albums-verification.md](reports/t03-albums-verification.md) | T03 城市和年份影集证据 |
| [reports/t04-originals-verification.md](reports/t04-originals-verification.md) | T04 原图上传、校验和保存证据 |
| [reports/t05-browsing-verification.md](reports/t05-browsing-verification.md) | T05 原图按需加载和浏览证据 |
| [reports/t06-batch-import-verification.md](reports/t06-batch-import-verification.md) | T06 批量导入及重试证据 |
| [reports/t07-editing-verification.md](reports/t07-editing-verification.md) | T07 文字、排序、草稿和冲突证据 |
| [reports/t08-organizing-verification.md](reports/t08-organizing-verification.md) | T08 跨影集移动与重复查看证据 |
| [reports/t09-trash-verification.md](reports/t09-trash-verification.md) | T09 回收站与恢复证据 |
| [reports/t10-cleanup-verification.md](reports/t10-cleanup-verification.md) | T10 到期清理和故障恢复证据 |
| [reports/t11-backup-verification.md](reports/t11-backup-verification.md) | T11 一致备份/校验/恢复证据 |
| [reports/t12-map-data-loading.md](reports/t12-map-data-loading.md) | T12 地图来源、配额、城市口径和加载核对 |
| [reports/t13-map-verification.md](reports/t13-map-verification.md) | T13 正式地图交付和真实来源检查 |
| [reports/t14-edge-verification.md](reports/t14-edge-verification.md) | T14 Edge 连续流程、隔离和布局回归 |
| [reports/t15-scale-verification.md](reports/t15-scale-verification.md) | T15 3400 份合成原图规模、双账号、内存与审计 |
| [reports/t16-local-delivery-verification.md](reports/t16-local-delivery-verification.md) | T16 本地第一版、空库与真实构建资源验收 |
| [reports/2026-10-17-repository-organization.md](reports/2026-10-17-repository-organization.md) | 本轮目录变更、路径说明及复测记录 |
| [reports/2026-10-17-ide-startup.md](reports/2026-10-17-ide-startup.md) | 开发软件核对、PyCharm 运行配置和隔离验证记录 |
| [reports/2026-10-21-v2-album-library.md](reports/2026-10-21-v2-album-library.md) | V2-01 白色界面、独立相册、封面偏好、迁移/备份兼容与本轮验证 |
| [reports/2026-10-22-china-city-map.md](reports/2026-10-22-china-city-map.md) | V2-02/V2-03 中国市级地图、公开源覆盖、交互与隔离端口验证 |
| [reports/2026-10-23-home-map-sidebar.md](reports/2026-10-23-home-map-sidebar.md) | V2-04 首页双栏、足迹/最近相册、滚轮滚页及专项验证 |
| [reports/2026-10-23-album-library-filters.md](reports/2026-10-23-album-library-filters.md) | V2-04 相册城市/地区和年份查找、排序、接口及隔离验证 |
| [reports/2026-10-23-album-card-layout.md](reports/2026-10-23-album-card-layout.md) | V2-04 共享相册卡片排版、空封面与窄屏视觉复查及既有行为回归 |
| [reports/2026-10-23-operation-feedback.md](reports/2026-10-23-operation-feedback.md) | V2-04 导入、封面和回收/恢复反馈、重试核对及本轮验证 |
| [reports/2026-10-23-connection-feedback.md](reports/2026-10-23-connection-feedback.md) | V2-04 连接错误分类、启动帮助、会话核对及隔离验证 |
| [reports/2026-10-23-mobile-details.md](reports/2026-10-23-mobile-details.md) | V2-04 手机触控控件、批量列表、短屏原图查看和地图触控的范围、验证及真机边界 |
| [reports/2026-10-23-province-borders.md](reports/2026-10-23-province-borders.md) | V2-04 省市边界层级、公共省界源线、保留城市交互及本轮验证 |
| [reports/2026-10-23-upload-entry-feedback.md](reports/2026-10-23-upload-entry-feedback.md) | V2-04 上传空闲光标与选图提示、批量入口及多选说明的范围和验证 |

## 独立验证工具

以下路径相对于 `validation/`。是否联网、是否重量级必须先读对应 README。

| 文件 | 用途 |
| --- | --- |
| [README.md](../validation/README.md) | 区分当前专项工具、历史探针与私有结果 |
| [local-delivery/README.md](../validation/local-delivery/README.md) | 构建版空库验收命令与测试数据说明 |
| [local-delivery/serve.py](../validation/local-delivery/serve.py) | 构建版空库迁移、独立端口合成服务与启动状态记录 |
| [scale/README.md](../validation/scale/README.md) | 样本生成、运行、复核、资源需求与安全限制 |
| [scale/generate.py](../validation/scale/generate.py) | 生成不同内容的 JPEG/PNG/WebP 合成大图与清单 |
| [scale/serve.py](../validation/scale/serve.py) | 专用隔离运行库和规模测试服务器 |
| [scale/harness.py](../validation/scale/harness.py) | 规模准备、正式协议导入、离线维护及完整性审计 CLI |
| [scale/memory.py](../validation/scale/memory.py) | Windows 进程内存采样辅助 |
| [scale/test_harness.py](../validation/scale/test_harness.py) | 工具对目录标记、数据库和审计边界的安全检查 |
| [map-plan/README.md](../validation/map-plan/README.md) | T12 离线/在线核验方法及边界 |
| [map-plan/.gitignore](../validation/map-plan/.gitignore) | 忽略本工具的真实响应、证据和运行产物 |
| [map-plan/guard.js](../validation/map-plan/guard.js) | 收集脱敏后的页面脚本异常，避免证据泄露 Key 或供应商响应 |
| [map-plan/audit-checks.mjs](../validation/map-plan/audit-checks.mjs) | 地图目录来源结构与核对规则 |
| [map-plan/wmts-adapter.js](../validation/map-plan/wmts-adapter.js) | 官方 WMTS 方案的视图、瓦片及投影适配 |
| [map-plan/map-plan.test.mjs](../validation/map-plan/map-plan.test.mjs) | 不读 Key、不联网的合成规则测试 |
| [map-plan/live.mjs](../validation/map-plan/live.mjs) | 显式启动独立浏览器进行真实地图核验 |
| [map-plan/live.html](../validation/map-plan/live.html) | 在线核验页面外壳 |
| [map-plan/live-client.js](../validation/map-plan/live-client.js) | 在线核验页面的地图请求和呈现逻辑 |
| [map-probe/README.md](../validation/map-probe/README.md) | 早期地图探针说明和历史结果 |
| [map-probe/.env.example](../validation/map-probe/.env.example) | 探针配置占位示例，不含真实 Key |
| [map-probe/.gitignore](../validation/map-probe/.gitignore) | 忽略私有配置、结果和临时浏览器数据 |
| [map-probe/run.mjs](../validation/map-probe/run.mjs) | 地图探针服务与浏览器检查入口 |
| [map-probe/index.html](../validation/map-probe/index.html) | 地图探针 HTML 页面 |
| [map-probe/client.js](../validation/map-probe/client.js) | 地图探针页面和断言逻辑 |
| [gallery-probe/README.md](../validation/gallery-probe/README.md) | 早期原图显示实验的运行说明与结论 |
| [gallery-probe/.gitignore](../validation/gallery-probe/.gitignore) | 忽略该实验的本地产物 |
| [gallery-probe/run.mjs](../validation/gallery-probe/run.mjs) | 读取显式指定的 JPEG 样本目录并启动原图实验；不默认运行 |
| [gallery-probe/index.html](../validation/gallery-probe/index.html) | 原图实验页面外壳 |
| [gallery-probe/client.js](../validation/gallery-probe/client.js) | 原图列表、查看器和浏览实验逻辑 |

## 历史原型

以下路径相对于 `prototype/`。这些文件是设计参照，不是正式应用的构建输入。

| 文件 | 用途 |
| --- | --- |
| [README.md](../prototype/README.md) | 历史原型定位与正式工程入口 |
| [travel-journal/README.md](../prototype/travel-journal/README.md) | 可点击原型启动、行为和验证限制 |
| [travel-journal/.gitignore](../prototype/travel-journal/.gitignore) | 忽略原型私有/生成产物 |
| [travel-journal/server.mjs](../prototype/travel-journal/server.mjs) | 原型本地服务与演示资源入口 |
| [travel-journal/index.html](../prototype/travel-journal/index.html) | 原型页面结构 |
| [travel-journal/app.js](../prototype/travel-journal/app.js) | 原型页面交互及演示状态 |
| [travel-journal/styles.css](../prototype/travel-journal/styles.css) | 原型通用样式 |
| [travel-journal/atlas.css](../prototype/travel-journal/atlas.css) | 原型地图样式 |
| [travel-journal/china-map.js](../prototype/travel-journal/china-map.js) | 原型地图绘制与交互 |
| [travel-journal/china-map-data.js](../prototype/travel-journal/china-map-data.js) | 原型地图来源请求、数据适配和地区口径 |
| [travel-journal/map-data-probe.html](../prototype/travel-journal/map-data-probe.html) | 原型地图数据诊断页面 |
| [travel-journal/map-data-probe.js](../prototype/travel-journal/map-data-probe.js) | 原型目录/边界诊断逻辑 |
| [travel-journal/assets/china-cities-source.md](../prototype/travel-journal/assets/china-cities-source.md) | 地图资料来源、审核和使用边界 |
| [travel-journal/assets/pin.svg](../prototype/travel-journal/assets/pin.svg) | 有记录城市的原型标记图标 |
| [travel-journal/assets/pin-empty.svg](../prototype/travel-journal/assets/pin-empty.svg) | 空城市的原型标记图标 |
| [travel-journal/assets/cluster.svg](../prototype/travel-journal/assets/cluster.svg) | 密集城市的原型聚合图标 |

## 本机可能看到、但不提交的目录和文件

| 路径/类别 | 用途与操作边界 |
| --- | --- |
| 根目录 `.env`、`validation/map-probe/.env.local` | 私有设置/地图 Key；不上传、不覆盖，现有引用路径保持 |
| `.local-data/` 或自定义数据目录 | 私人账号、数据库、原图、暂存和认证密钥；不要当缓存清空 |
| `backend/.venv/` | 项目 Python 虚拟环境，按锁文件可重建，不当源码编辑 |
| `backend/.uv-cache/` | uv 下载/构建缓存，不是业务代码 |
| `frontend/node_modules/` | npm 安装依赖，按锁文件可重建，不手改依赖源码 |
| `frontend/dist/` | 前端构建页面，`npm run build` 生成；日常预览需要它 |
| `frontend/test-results/`、`playwright-report/` | 本机回归结果与截图，不上传 |
| `validation/**/results/` 等工具输出 | 合成样本、隔离数据库、运行日志/证据及固定公共地图源下载缓存；可能很大，只按工具说明核对清理 |
| `__pycache__/`、`.pytest_cache/`、`.ruff_cache/` | Python/测试/静态检查自动缓存 |
| `.git/` | 版本历史和远程信息，不手动移动内部文件 |
| IDE 配置、系统临时文件 | 不属于产品；按 `.gitignore` 排除 |

2026-10-17 目录整理只调整源码和文档，没有清理上述本地数据；当时移除的仅为已有迁移脚本目录内的 `.gitkeep` 空占位文件，可从 Git 历史恢复。V2-01、中国地图和首页改善新增文件列于上表；地图公共资产可以提交，私人资料及测试结果仍留本机。
