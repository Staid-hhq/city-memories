# 仓库目录整理（2026-10-17）

## 范围

按用户要求整理代码与文档，并提供逐文件用途说明。起点为 T16 提交 `114407d`，工作区干净；本轮不是 T17，没有部署或新增业务功能。

- 文档按使用指南、产品需求、架构设计、计划、来源参考和历史报告分类；保留原文件名和历史结论，更新相对链接与路径示例。
- 首页缩为项目状态、导航和启动入口；原有功能操作内容移到[功能指南](../guides/user-guide.md)，不另复制一套接口/架构文档。
- 前端按应用入口、业务功能、共享请求、样式分类；城市/影集纯类型从页面模块抽到 `types.ts`，业务逻辑不变。
- 默认、交付和规模测试统一在 `frontend/tests/` 下分区；更新配置、分组脚本、模块引用、目录相对定位和地图测试中的动态模块路径。
- 后端保留标准 Python `src` 布局和已有业务模块；仅更新文档引用及移除已有迁移目录中的空占位 `.gitkeep`。占位文件可由 Git 历史恢复。
- 原型和验证工具保留实际位置，新增索引说明历史/当前职责；不移动或读取 `.env`、地图 Key、私人运行库/原图，不移动或删除大型测试结果。
- 新增[文件导航](../file-guide.md)逐项覆盖仓库文件；新增只读 `scripts/check-repository.mjs`，检查本地文档文件目标、导航覆盖和项目模块导入。检查不验证 Markdown 锚点、外部链接或运行时行为。

## 路径对应

| 以前 | 现在 |
| --- | --- |
| `docs/local-first-release.md`、`backup-restore.md` | `docs/guides/`，新增功能使用指南 |
| `docs/project-brief.md`、`requirements.md`、`page-flow.md` | `docs/product/` |
| `docs/tech-stack.md`、数据/API、SQL、账号存储、地图方案 | `docs/architecture/` |
| `docs/development-plan.md` | `docs/planning/development-plan.md` |
| 三城映射、正式城市目录审核 | `docs/reference/` |
| 可行性、Edge 复查和 T02–T16 报告 | `docs/reports/` |
| `frontend/src/` 内平铺的业务组件 | `src/app/`、`src/features/{albums,imports,photos,map,trash}/` |
| `frontend/src/api.ts`、`styles.css` | `src/shared/api.ts`、`src/styles/global.css` |
| `frontend/tests/*.spec.ts` | `frontend/tests/e2e/*.spec.ts` |
| `frontend/delivery/`、`frontend/scale/` | `frontend/tests/delivery/`、`frontend/tests/scale/` |

网页路由、API 地址、数据库迁移版本、命令名、端口与私人数据位置均未改变。历史报告的源码/文档链接指向当前文件；上表专门保留旧路径用于查找，不视为失效链接。

## 验证

环境：Windows、项目 Python 3.13、Node 24.18.0、Microsoft Edge **155.0.4283.60**。浏览器使用独立可见窗口，后端使用临时/专用合成数据；没有启动日常私人库。

| 检查 | 实际结果 |
| --- | --- |
| 后端全量 `pytest -q` | **259 项通过**，96.83 秒；公共目录说明路径更新后另复核地图 9 项通过，不叠加计数 |
| 后端 Ruff、前端 ESLint | 通过 |
| 前端应用类型检查与生产构建 | 通过；HTML、JS、CSS 的 SHA-256 均与 [T16 产物](t16-local-delivery-verification.md#构建记录)一致 |
| 全部前端测试与三份 Playwright 配置的严格类型检查 | 通过；补一处测试分页响应类型标注，不改变执行逻辑 |
| 默认 Edge 分组回归 | 最终 **48 + 8 + 1 = 57 项通过**（52 组浏览器流程、5 项纯规则/调度）；真实地图在线 1 项按计划跳过 |
| 构建版空库 `npm run test:delivery` | **2 项通过**，8.4 秒；实际构建资源、深链接刷新、代理、端口占用与完整连续流程 |
| 离线地图规则 | `node --test validation/map-plan/map-plan.test.mjs`，**27 项通过**，不读 Key、不联网 |
| 规模工具安全测试 | 后端环境执行 `pytest ../validation/scale/test_harness.py -q`，**5 项通过** |
| 规模测试路径收集 | `playwright test --config=playwright.scale.config.ts --list` 正确收集 1 项；未执行重量级测试 |
| 仓库导航检查 | **174 个文件**全部有用途说明，本地文档文件目标及项目模块导入均解析成功 |
| 交付边界 | 私有配置/数据/测试结果仍被 Git 忽略；提交清单与新增内容检查未发现真实凭据；测试后 8000/5173 无遗留监听 |

本轮未重复 T15 大型样本生成和完整规模测试，未执行真实地图在线调用或公网部署；未升级依赖。后端沿用两条 Starlette/httpx、AnyIO 兼容性弃用提示，不把提示隐藏为无告警。

## 诊断与修正

- 初次路径迁移中，Windows 大小写不敏感使入口 `./App` 与新建 `app/` 目录混淆；构建及时报错，已明确改为 `./app/App`。之后生产构建及实际页面回归通过。
- 扩展到全部测试文件的严格类型检查发现既有批量测试的分页响应类型推断循环；只补明确的数据类型，未修改测试断言。检查命令使用 TypeScript 6 的 `--ignoreConfig` 和明确文件清单。
- 首次默认回归：业务组 48 项通过，地图组末项在登录表单出现前遇到 `/api/v1/auth/me` 的 `socket hang up`；快照显示“暂时连接不上服务”。该次失败不计通过，不能证明是目录调整引起，也未确定底层原因。保持 `retries: 0`、超时与业务限制不变，独立地图组 **8 项通过（24.7 秒）**，之后重新完整分组 **57 项通过**，未复现。初次诊断保留在忽略的 `frontend/test-results/organization-first-map-error.md`。
- 早期可行性文档中 5 个链接指向从不上传的本机证据，改为明确的本机路径说明，不伪造公开链接、不读取或上传证据。

所有迁移都有 Git 重命名记录；没有删除业务代码、原型或历史报告。只移除多余空占位文件及两个搬空的测试目录。
