# 文档索引

当前进度：T01–T16 已完成，T17 待安排。日常操作以使用指南为准；历史报告保留当时的环境、失败过程与限制，不因归档而视为过期或全部重新验收。

## 按目的阅读

| 目录 | 内容与入口 |
| --- | --- |
| `guides/` | 面向使用者：[PyCharm 启动](guides/ide-startup.md)、[启动与维护](guides/local-first-release.md)、[功能操作](guides/user-guide.md)、[备份恢复](guides/backup-restore.md) |
| `product/` | 做什么：[项目定位](product/project-brief.md)、[需求与验收](product/requirements.md)、[页面流程](product/page-flow.md) |
| `architecture/` | 怎么实现：[技术栈](architecture/tech-stack.md)、[数据/API](architecture/data-api-design.md)、[SQL 设计样例](architecture/data-model.sql)、[账号存储](architecture/account-storage-plan.md)、[地图方案](architecture/map-plan.md) |
| `planning/` | 任务进度与逐项实施记录：[开发计划](planning/development-plan.md) |
| `reference/` | 目录来源和审核依据：[初始三城映射](reference/t03-city-mappings.md)、[正式城市目录](reference/t13-city-catalog.md) |
| `reports/` | 历次测试、交付和维护证据，见下表 |

[文件导航](file-guide.md)逐项说明仓库文件的用途；开发者从[前端说明](../frontend/README.md)或[后端说明](../backend/README.md)进入代码。

## 验证与交付记录

| 记录 | 范围 |
| --- | --- |
| [早期可行性](reports/feasibility.md) | 地图、账号存储和原图显示的首轮证据 |
| [原型 Edge 复查](reports/edge-review-2026-09-21.md) | 2026-09-21 可点击原型，不是正式产品回归 |
| [T02](reports/t02-auth-verification.md) | 注册、登录与授权 |
| [T03](reports/t03-albums-verification.md) | 城市与年份影集 |
| [T04](reports/t04-originals-verification.md) | 原图接收、校验、保存 |
| [T05](reports/t05-browsing-verification.md) | 按需读取与跨页浏览 |
| [T06](reports/t06-batch-import-verification.md) | 批量导入与重试 |
| [T07](reports/t07-editing-verification.md) | 文字与影集排序 |
| [T08](reports/t08-organizing-verification.md) | 跨影集移动与重复查看 |
| [T09](reports/t09-trash-verification.md) | 回收站与恢复 |
| [T10](reports/t10-cleanup-verification.md) | 到期清理与故障恢复 |
| [T11](reports/t11-backup-verification.md) | 一致备份与恢复工具 |
| [T12](reports/t12-map-data-loading.md) | 地图数据、口径与加载核对 |
| [T13](reports/t13-map-verification.md) | 正式地图与本人资料联动 |
| [T14](reports/t14-edge-verification.md) | 实际 Edge 连续流程回归 |
| [T15](reports/t15-scale-verification.md) | 原图规模、并发与内存 |
| [T16](reports/t16-local-delivery-verification.md) | 本地构建版空库交付 |
| [2026-10-17 目录整理](reports/2026-10-17-repository-organization.md) | 文件分类、路径迁移与回归结果 |
| [2026-10-17 IDE 启动整理](reports/2026-10-17-ide-startup.md) | PyCharm 共享运行配置、隔离启动/停止与 Edge 验证 |

T01 的实施证据在开发计划。保留原有报告文件名便于按任务编号查找；没有复制另一套架构、接口或任务清单。

## 文档维护规则

- 新指南放 `guides/`，业务范围放 `product/`，实现设计放 `architecture/`；进度只维护开发计划。
- 测试/交付报告放 `reports/`，资料来源与审核表放 `reference/`；历史结果不改写为当前测试结果。
- 新增、删除或移动文件时同步更新[文件导航](file-guide.md)，根目录运行 `node scripts/check-repository.mjs`。
- Markdown 使用相对链接；命令说明标明执行目录，避免依赖文档所在目录。
- 公开文档只放脱敏结论，不附真实 Key、原图、数据库和私人截图。
