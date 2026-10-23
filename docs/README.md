# 文档索引

当前进度（2026-10-24）：T01–T16、V2-01 白色界面/独立相册及 V2-02/V2-03 中国市级地图已完成；V2-04 已完成首页双栏、地图交互、相册查找、卡片排版、操作反馈、连接提示、手机端细节、省市边界层级、上传入口及城市相册层级子项，整体验收和 T17 部署待安排。当前“我的相册”每个城市只显示一张卡，进入后查看多个年份影集框，再进入照片；新只读聚合接口需要正常重启项目加载，没有新增数据库迁移。进度以[开发计划](planning/development-plan.md)为准，本轮证据见[城市相册层级记录](reports/2026-10-24-city-album-hierarchy.md)，此前各轮证据见下表。日常操作以[功能指南](guides/user-guide.md)为准；历史报告保留当时的环境、失败过程与限制，不因归档而视为过期或全部重新验收。

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
| [2026-10-21 V2-01 独立相册](reports/2026-10-21-v2-album-library.md) | 白色界面、独立相册、封面偏好、迁移与新旧备份兼容；地图剩余范围 |
| [2026-10-22 中国市级地图](reports/2026-10-22-china-city-map.md) | 中国市级静态矢量、391 入口覆盖、本人填色、来源许可及隔离端口验证 |
| [2026-10-23 首页双栏与滚动](reports/2026-10-23-home-map-sidebar.md) | 紧凑地图、本人足迹、最近相册、滚轮滚页及最近排序接口 |
| [2026-10-23 相册查找](reports/2026-10-23-album-library-filters.md) | 城市/所属地区搜索、本人年份选项、组合筛选与排序、返回及请求隔离 |
| [2026-10-23 相册卡片排版](reports/2026-10-23-album-card-layout.md) | 共享 3:4 封面、完整城市名、年份/照片数对齐、空封面与窄屏复查 |
| [2026-10-23 操作反馈](reports/2026-10-23-operation-feedback.md) | 导入、封面和删除/恢复的持续进度、明确结果与查询/重试入口 |
| [2026-10-23 连接与启动提示](reports/2026-10-23-connection-feedback.md) | 服务响应分类、启动帮助、手动会话核对与草稿/账号边界 |
| [2026-10-23 手机端细节](reports/2026-10-23-mobile-details.md) | 触控控件、批量列表局部横滚、短屏原图查看及地图触摸滚页/移动切换 |
| [2026-10-23 省市边界层级](reports/2026-10-23-province-borders.md) | 增加独立省界线层、保留细市界与逐市填色及交互、固定公开源与隔离验证 |
| [2026-10-23 上传入口与空闲提示](reports/2026-10-23-upload-entry-feedback.md) | 修正禁用按钮的等待光标、补充未选文件提示、邻近批量入口与电脑多选说明 |
| [2026-10-24 城市相册层级](reports/2026-10-24-city-album-hierarchy.md) | 一城市一相册、城市内多个年份框、本人聚合接口及统计/封面/逐级返回规则 |

T01 的实施证据在开发计划。保留原有报告文件名便于按任务编号查找；没有复制另一套架构、接口或任务清单。

## 文档维护规则

- 新指南放 `guides/`，业务范围放 `product/`，实现设计放 `architecture/`；进度只维护开发计划。
- 测试/交付报告放 `reports/`，资料来源与审核表放 `reference/`；历史结果不改写为当前测试结果。
- 新增、删除或移动文件时同步更新[文件导航](file-guide.md)，根目录运行 `node scripts/check-repository.mjs`。
- Markdown 使用相对链接；命令说明标明执行目录，避免依赖文档所在目录。
- 公开文档只放脱敏结论，不附真实 Key、原图、数据库和私人截图。
