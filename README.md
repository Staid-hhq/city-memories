# 城影记（City Memories）

按城市和年份保存原图、文字与旅行记忆的本地网页应用。支持账号隔离、批量导入、排序、跨影集移动、重复查看、回收站恢复、到期清理与离线备份；地图只点亮本人有有效照片的城市。

**状态（2026-10-17）：T01–T16 已完成，本地第一版已交付；T17 部署待安排，尚未公开上线。** 当前支持 391 个已审核城市及同级目的地；草湖市待供应商映射。项目整理不改变现有功能、接口或数据位置。

## 从这里开始

| 想做什么 | 阅读入口 |
| --- | --- |
| 在 PyCharm 中点击按钮启动 | [开发软件启动指南](docs/guides/ide-startup.md) |
| 日常启动、停止、安装与更新 | [本地第一版使用手册](docs/guides/local-first-release.md) |
| 导入、浏览、整理和恢复照片 | [功能使用指南](docs/guides/user-guide.md) |
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
├─ scripts/     仓库维护检查（不启动产品，不读取私人资料）
├─ validation/  独立验证工具；历史探针与当前交付/规模工具分开说明
├─ prototype/   早期可点击原型，仅供设计参照
├─ AGENTS.md    协作、GitHub 同步和公开仓库安全约定
└─ .gitignore   私人数据、密钥、依赖及构建产物的忽略规则
```

根目录 `.env`、`.local-data/` 和工具的 `results/` 是本机私有配置/数据，不属于源码，不上传 GitHub。依赖目录和构建产物也不入库。

## 本机快速启动

**推荐在 PyCharm 中启动**：打开整个项目，右上角选择“城影记－启动”，点击绿色三角，等待前后端就绪后在 Edge 打开 <http://127.0.0.1:5173>。首次无构建或前端代码更新后，先运行“城影记－前端构建”。详见[软件内启动与停止步骤](docs/guides/ide-startup.md)。

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
- 常规回归使用隔离数据库和合成图片，不读取私人账号、照片或现有数据库；真实地图联网和重量级规模测试不自动执行，见 [验证工具索引](validation/README.md)。

本地第一版已通过后端 259 项、默认前端 57 项及构建版空库交付 2 项检查；400/3000 张原图与双账号并发的既有证据见 [T15](docs/reports/t15-scale-verification.md)。当前整理的复测结果见 [目录整理记录](docs/reports/2026-10-17-repository-organization.md)。

## 使用边界

GitHub 只管理源码与文档，不备份照片和数据库。真实资料的独立备份介质、频率与保留策略仍需落实。地图浏览器 Key 虽不进仓库和构建，登录浏览器可见其运行时请求；正式域名限制、使用条件、HTTPS 和跨电脑访问仍属于 T17。历史报告中的“下一项”表示当时状态，当前进度以开发计划为准。
