# 文档索引

更新：2026-11-06。先按用途查找；逐文件说明在[文件导航](file-guide.md)，任务状态统一维护在[开发计划](planning/development-plan.md)。

## 常用入口

| 用途 | 文档 |
| --- | --- |
| 启动与停止 | [PyCharm 启动](guides/ide-startup.md) |
| 安装、升级和排障 | [本地使用手册](guides/local-first-release.md) |
| 导入、浏览和整理照片 | [功能使用指南](guides/user-guide.md) |
| 备份与恢复 | [备份操作说明](guides/backup-restore.md) |
| 阅读前后端代码 | [前端说明](../frontend/README.md)、[后端说明](../backend/README.md)、[文件导航](file-guide.md) |

## 文档分类

| 目录 | 内容与入口 |
| --- | --- |
| `guides/` | 上表中的日常使用、启动、安装和维护说明 |
| `product/` | [项目定位](product/project-brief.md)、[需求与验收](product/requirements.md) |
| `architecture/` | [技术栈](architecture/tech-stack.md)、[数据/API](architecture/data-api-design.md)、[地图方案](architecture/map-plan.md) |
| `planning/` | [开发计划与任务状态](planning/development-plan.md) |
| `reference/` | [城市目录审核与首批三城映射](reference/t13-city-catalog.md) |
| `reports/` | [按准备阶段、第一版、第二版、维护分类的报告索引](reports/README.md) |

## 验证与交付记录

完整记录集中在[报告索引](reports/README.md)，这里仅保留近期入口：

- [首页侧栏与视觉整理](reports/v2/2026-11-06-sidebar-visual-round-three.md)。
- [维护日志](reports/maintenance/maintenance-log.md)：改名兼容、文件整理、文档优化与精简。

T01–T16 和已交付的第二版子项保留各自验收条件；V2-04、第二版整体验收与 T17 部署仍待安排。历史报告中的名称、测试条数和输出路径表示当时情况；本地测试产物可按已记录的清理操作移除，需要时重新运行工具生成。

## 文档维护规则

- 日常说明放 `guides/`，业务范围放 `product/`，设计放 `architecture/`，来源资料放 `reference/`。
- 功能与独立验收报告按 `reports/preparation/`、`reports/v1/`、`reports/v2/` 分类；小型维护追加[维护日志](reports/maintenance/maintenance-log.md)，不再单独新建报告。新增文件登记报告索引和文件导航。
- 新增或移动文件时修正相对链接，在根目录运行 `node scripts/check-repository.mjs`；进度只维护开发计划。
- 历史结果保留当时含义，不改写为当前测试结果。公开文档只放脱敏结论，私人配置、照片、数据库和测试产物留在本机。
