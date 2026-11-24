# 文档索引

更新于 2026-11-24。逐文件说明见[文件导航](file-guide.md)，任务状态见[开发计划](planning/development-plan.md)。

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
| `product/` | [产品需求与验收标准（本轮重构）](product/requirements.md)、[项目定位](product/project-brief.md) |
| `architecture/` | [技术与地图架构](architecture/tech-stack.md)、[当前数据/API 契约](architecture/data-api-design.md) |
| `planning/` | [开发计划与任务状态](planning/development-plan.md) |
| `reference/` | [城市目录审核与首批三城映射](reference/t13-city-catalog.md) |
| `reports/` | [历史交付与维护](reports/README.md) |

## 验证与交付记录

准备阶段、第一版和第二版旧报告可从[报告索引](reports/README.md)查阅。近期目录整理、文档维护和改名兼容记录见[维护日志](reports/maintenance/maintenance-log.md)。

## 文档维护规则

- 日常说明放 `guides/`，业务范围放 `product/`，设计放 `architecture/`，来源资料放 `reference/`。
- 功能与独立验收报告按 `reports/preparation/`、`reports/v1/`、`reports/v2/` 分类；小型维护追加[维护日志](reports/maintenance/maintenance-log.md)，不再单独新建报告。新增文件登记报告索引和文件导航。
- 新增或移动文件时修正相对链接，在根目录运行 `node scripts/check-repository.mjs`；进度只维护开发计划。
- 历史结果保留当时含义，不改写为当前测试结果。公开文档只放脱敏结论，私人配置、照片、数据库和测试产物留在本机。
