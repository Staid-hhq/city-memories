# 此间集（Cijianji）

按“城市相册 → 年份影集 → 照片”收藏原图、文字和旅行回忆的本地网页应用。每个账号管理自己的资料；地图只点亮本人有有效照片的城市。

目前提供照片导入与重试、文字/排序、跨影集移动、重复查看、回收站与恢复、到期清理及离线备份。中国地图、城市相册和本轮界面整理已实现；V2-04 与第二版整体验收、T17 部署仍待安排，尚未公开上线。当前进度以[开发计划](docs/planning/development-plan.md)为准。

产品原名「城影记」，英文展示现为 `CIJIANJI`；目录、代码包、配置和备份仍沿用原技术标识，无需迁移资料，见[改名记录](docs/reports/maintenance/2026-11-06-product-rename.md)。

## 从这里开始

| 想做什么 | 入口 |
| --- | --- |
| 在 PyCharm 中启动、停止项目 | [软件启动指南](docs/guides/ide-startup.md) |
| 首次安装、更新或排查启动问题 | [本地使用手册](docs/guides/local-first-release.md) |
| 导入、浏览和整理照片 | [功能使用指南](docs/guides/user-guide.md) |
| 备份与恢复 | [备份操作说明](docs/guides/backup-restore.md) |
| 找代码、了解每个文件的作用 | [文件导航](docs/file-guide.md) |
| 看需求、架构或历史交付 | [文档索引](docs/README.md)、[报告索引](docs/reports/README.md) |

## 本机快速启动

推荐打开整个 `D:\Workspace\city-memories` 项目，在 PyCharm 选择 **「此间集－启动」**，点击绿色运行按钮，等前后端就绪后，在 Edge 打开 <http://127.0.0.1:5173>。

首次安装、第一版升级或缺少构建时，先按[完整手册](docs/guides/local-first-release.md#3-新机器首次准备或更新后)准备环境及迁移；运行按钮不会自动升级数据库。前端更新后先运行「此间集－前端构建」，再启动或刷新页面。

已有依赖、迁移与构建时，也可分别打开两个 PowerShell 终端：

```powershell
# 终端 A：后端
Set-Location 'D:\Workspace\city-memories\backend'
& .\.venv\Scripts\python.exe -m uvicorn city_memories.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers --no-access-log
```

```powershell
# 终端 B：前端
Set-Location 'D:\Workspace\city-memories\frontend'
npm run start:local
```

终端分别按 `Ctrl+C` 停止；PyCharm 停止方式见启动指南。两种方式任选一种，不同时启动两份服务。首次使用自行注册，没有默认账号。

## 目录结构

| 目录 | 放什么 |
| --- | --- |
| `frontend/` | 正式页面、公共地图资产和前端测试 |
| `backend/` | 接口、数据模型、数据库迁移和后端测试 |
| `docs/` | 使用指南、需求、架构、开发计划与分类报告 |
| `scripts/` | 仓库检查、公共地图数据生成 |
| `validation/` | 交付/规模验证，以及保留原路径的历史探针 |
| `prototype/` | 历史可点击原型，供设计和验证复现参考 |
| `.run/` | PyCharm 共享运行配置 |

日常开发主要看 `frontend/src/` 和 `backend/src/city_memories/`。完整职责与本机生成目录说明见[文件导航](docs/file-guide.md)。

## 开发与验证

前端命令见[前端说明](frontend/README.md)，后端环境与命令见[后端说明](backend/README.md)。根目录运行 `node scripts/check-repository.mjs` 检查文档目标、文件导航和本地模块导入。

测试使用隔离数据和合成图片；重量级规模验证须单独执行，见[验证工具索引](validation/README.md)。历次测试条件、通过项与未测范围分别保存在[分类报告](docs/reports/README.md)，历史结果不代替本轮验证。

## 使用边界

根目录 `.env`、`.local-data/` 或自定义数据目录属于本机私人资料；不上传 GitHub，不作为缓存删除。依赖、构建和测试产物也不入库。源码版本管理不能代替照片与数据库的独立备份。

当前仅监听本机，Vite 预览不是公网生产服务器。公开访问、HTTPS、容量及备份保留策略属于 T17。地图使用固定公共数据快照，覆盖 391 个已审核城市及同级目的地，草湖市仍待映射；来源与使用边界见[地图数据说明](frontend/public/map-data/NOTICE.md)。
