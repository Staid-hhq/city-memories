# 城影记（City Memories）

按“城市相册 → 年份影集 → 照片”保存原图、文字与旅行记忆的本地网页应用。一个城市在相册库中只显示一张相册卡，进入后查看该城市的多个年份影集框。支持账号隔离、批量导入、排序、跨影集移动、重复查看、回收站恢复、到期清理与离线备份；地图只点亮本人有有效照片的城市。

**状态（2026-10-30）：T01–T16、V2-01 白色界面与独立相册、V2-02/V2-03 中国市级地图已完成；V2-04 已完成首页双栏、地图交互、相册查找、卡片排版、操作反馈、连接提示、手机端细节、省市边界层级、上传入口、城市相册层级、省会默认入口、市界按状态显示、小城市可见与点击及首页第一轮精简子项，整体验收待安排。T17 部署待安排，尚未公开上线。** 地图只绘制中国，覆盖 391 个已审核城市及同级目的地；草湖市仍待映射。省界始终显示，普通未点亮城市同色无市界，有本人有效照片的城市填色并显示细边界；鼠标经过或键盘聚焦时临时显界，移开后恢复。直辖市及港澳外轮廓沿用省级边界和海岸线，桌面画布增至 640px，点击仍进入城市相册。首页右侧提供本人足迹统计和最近整理的年份影集，地图内滚轮缩放、地图外滚动页面；触摸默认滑动页面，可明确开启“移动地图”。“我的相册”按城市聚合，支持城市/所属地区搜索、本人年份筛选及年份/最近整理排序；年份筛选选出包含该年份的城市，卡片仍显示整座城市的年份影集数、有效照片数和封面。进入城市后按年份查看 3:4 封面卡，再打开对应照片；空年份影集保留。导入、换封面及删除/恢复以页面内持续提示说明进度、结果和下一步；服务连接失败时提供启动帮助和手动核对入口。手机布局改善常用控件、批量队列和原图查看层。当前进度见[开发计划](docs/planning/development-plan.md)，本轮证据见[首页精简与地图工具整理](docs/reports/2026-10-30-home-map-round-one.md)。

首页“选择一座城市”默认每个省级地区一个入口，展示省会、自治区首府、直辖市和港澳本身，台湾地区使用台北，共 34 项按城市拼音 A–Z 一次显示完；广东默认只列广州。搜索仍可查找深圳等全国已开放城市，点“返回省会列表”恢复默认入口。

首页欢迎区收紧，移除重复英文标题和章节装饰；地图上方集中城市搜索、缩放和全国视图。点入搜索框可展开香港、澳门、珠海快捷入口，也可输入其他城市名称定位。定位按整座城市的真实范围放大，并保留城市卡和“打开相册”入口，小区域无需精确点中地图色块。正常状态下“重新核对地图”收在“更多”中；地图加载失败或资料不完整时直接显示重试入口。详见[首页精简与地图工具整理](docs/reports/2026-10-30-home-map-round-one.md)。

本次首页第一轮优化为纯前端更新；已加载此前省会查询接口时，重建前端后 `Ctrl+F5` 即可，无需重启后端。尚未加载省会默认入口接口时，仍需正常停止项目、重建前端、正常启动再刷新；已完成 V2-01 升级时无需重复迁移或重新导入照片。

## 从这里开始

| 想做什么 | 阅读入口 |
| --- | --- |
| 在 PyCharm 中点击按钮启动 | [开发软件启动指南](docs/guides/ide-startup.md) |
| 日常启动、停止、安装与更新 | [本地第一版使用手册](docs/guides/local-first-release.md) |
| 升级白色界面、独立相册与封面选择 | [V2-01 实施与验证](docs/reports/2026-10-21-v2-album-library.md) |
| 按城市打开相册，再浏览多个年份影集 | [城市相册层级](docs/reports/2026-10-24-city-album-hierarchy.md)、[功能使用指南](docs/guides/user-guide.md) |
| 使用只显示中国的市级填色地图 | [中国城市地图交付](docs/reports/2026-10-22-china-city-map.md)、[省市边界层级](docs/reports/2026-10-23-province-borders.md) |
| 查看紧凑首页、地图搜索和工具入口 | [首页精简与地图工具整理](docs/reports/2026-10-30-home-map-round-one.md) |
| 放大香港、澳门、珠海或定位其他小城市 | [小城市可见与点击](docs/reports/2026-10-26-small-city-access.md) |
| 查看省界常显、点亮/悬停市界及地图高度 | [市界显示与地图高度](docs/reports/2026-10-26-map-boundary-visibility.md) |
| 从各省会入口选城或搜索其他城市 | [省会默认入口](docs/reports/2026-10-25-province-city-entries.md)、[功能使用指南](docs/guides/user-guide.md) |
| 查看首页足迹、最近相册与滚动改进 | [首页双栏与滚动改善](docs/reports/2026-10-23-home-map-sidebar.md) |
| 按城市、所属地区和年份查找相册 | [相册筛选与排序](docs/reports/2026-10-23-album-library-filters.md) |
| 查看相册封面、长城市名和空相册排版 | [相册卡片排版](docs/reports/2026-10-23-album-card-layout.md) |
| 核对导入、封面和回收/恢复的操作结果 | [操作反馈与重试](docs/reports/2026-10-23-operation-feedback.md) |
| 处理启动连接失败、服务异常或登录过期 | [连接与启动提示](docs/reports/2026-10-23-connection-feedback.md) |
| 使用手机布局、批量列表和地图触控 | [手机端细节](docs/reports/2026-10-23-mobile-details.md) |
| 导入、浏览、整理和恢复照片 | [功能使用指南](docs/guides/user-guide.md) |
| 了解上传按钮状态和一次选择多张照片 | [上传入口与空闲提示](docs/reports/2026-10-23-upload-entry-feedback.md) |
| 备份与恢复资料 | [备份操作说明](docs/guides/backup-restore.md) |
| 看每个文件的用途、找代码 | [文件导航](docs/file-guide.md) |
| 找需求、设计和历次验证 | [文档索引](docs/README.md) |
| 查看进度和下一项任务 | [开发计划](docs/planning/development-plan.md) |

## 目录结构

```text
city-memories/
├─ .run/        PyCharm 共享运行配置：启动、前端、后端和前端构建
├─ frontend/    React + TypeScript 页面、前端测试和构建配置
├─ backend/     FastAPI 服务、数据模型、迁移和后端测试
├─ docs/        使用指南、需求、架构、计划、参考资料、验收记录
├─ scripts/     仓库维护检查与公共地图生成（不读取私人资料）
├─ validation/  独立验证工具；历史探针与当前交付/规模工具分开说明
├─ prototype/   早期可点击原型，仅供设计参照
├─ AGENTS.md    协作、GitHub 同步和公开仓库安全约定
└─ .gitignore   私人数据、密钥、依赖及构建产物的忽略规则
```

根目录 `.env`、`.local-data/` 和工具的 `results/` 是本机私有配置/数据，不属于源码，不上传 GitHub。依赖目录和构建产物也不入库。

## 本机快速启动

**推荐在 PyCharm 中启动**：打开整个项目，右上角选择“城影记－启动”，点击绿色三角，等待前后端就绪后在 Edge 打开 <http://127.0.0.1:5173>。首次无构建或前端代码更新后，先运行“城影记－前端构建”。详见[软件内启动与停止步骤](docs/guides/ide-startup.md)。

**首次升级 V2-01 还需显式升级数据库。** 先正常停止服务，核对实际数据目录并完成独立备份；从项目 `backend` 目录执行 `& .\.venv\Scripts\python.exe -m alembic upgrade head`，成功后再构建前端、正常启动。当前迁移头为 `c7e9a162b4d8`；PyCharm 运行按钮不会自动迁移。本轮只在合成测试库执行升级，没有读取或升级用户真实数据库，完整步骤见[更新说明](docs/guides/local-first-release.md#3-新机器首次准备或更新后)。

**城市相册层级更新新增只读聚合接口，不新增数据库迁移。** 已完成上述 V2-01 升级时，先正常停止项目、重建前端，再正常启动项目以加载新后端接口，最后 `Ctrl+F5` 刷新；仅构建前端不能加载新接口。不必重复迁移、重建相册或填写地图 Key，已有城市、年份影集及照片归属不变。公开矢量随应用加载，来源和固定版本见[数据说明](frontend/public/map-data/NOTICE.md)。

以下保留 PowerShell 方式作为备用，两种方式不要同时运行。

已有依赖、迁移与构建时，在两个 PowerShell 终端分别执行；首次安装或更新先看 [完整手册](docs/guides/local-first-release.md#3-新机器首次准备或更新后)，不要覆盖现有配置或数据。

终端 A（后端）：

```powershell
Set-Location 'D:\Workspace\city-memories\backend'
& .\.venv\Scripts\python.exe -m uvicorn city_memories.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers --no-access-log
```

终端 B（前端）：

```powershell
Set-Location 'D:\Workspace\city-memories\frontend'
npm run start:local
```

Edge 打开 <http://127.0.0.1:5173>，自行注册后使用，没有默认账号。两个终端分别按 `Ctrl+C` 停止。代码更新后先 `npm run build`；开发模式使用 `npm run dev -- --strictPort`，不要与构建预览同时启动。仅监听本机，Vite 预览不是公网生产服务器。

## 开发与验证

- 前端命令、源码分区、测试分组：[frontend/README.md](frontend/README.md)。
- 后端环境、接口与维护边界：[backend/README.md](backend/README.md)。
- 根目录执行 `node scripts/check-repository.mjs` 检查文档链接、文件导航覆盖及移动后的本地模块引用。
- 常规回归使用隔离数据库和合成图片，不读取私人账号、照片或现有数据库；新地图默认检查随应用提供的公共矢量，不读取地图 Key，重量级规模测试仍须单独安排，见 [验证工具索引](validation/README.md)。

本地第一版验收曾通过后端 259 项、默认前端 57 项及构建版空库交付 2 项检查；400/3000 张原图与双账号并发的既有证据见 [T15](docs/reports/t15-scale-verification.md)。第二版的实际结果和边界分别见 [V2-01 记录](docs/reports/2026-10-21-v2-album-library.md)、[中国地图记录](docs/reports/2026-10-22-china-city-map.md)、[首页改善记录](docs/reports/2026-10-23-home-map-sidebar.md)、[相册查找记录](docs/reports/2026-10-23-album-library-filters.md)、[卡片排版记录](docs/reports/2026-10-23-album-card-layout.md)、[操作反馈记录](docs/reports/2026-10-23-operation-feedback.md)、[连接提示记录](docs/reports/2026-10-23-connection-feedback.md)、[手机端细节记录](docs/reports/2026-10-23-mobile-details.md)、[省市边界层级记录](docs/reports/2026-10-23-province-borders.md)、[上传入口记录](docs/reports/2026-10-23-upload-entry-feedback.md)和[城市相册层级记录](docs/reports/2026-10-24-city-album-hierarchy.md)，历史结果不代替本轮验证。

## 使用边界

GitHub 只管理源码、公共地图资产与文档，不备份照片和数据库。真实资料的独立备份介质、频率与保留策略仍需落实。新地图不调用在线地图服务；公共边界为固定快照，不宣称实时更新或已通过官方地图审查。正式域名、公开使用条件、HTTPS 和跨电脑访问仍属于 T17。历史报告中的“下一项”表示当时状态，当前进度以开发计划为准。
