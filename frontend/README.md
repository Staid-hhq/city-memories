# 城影记前端

React 19 + TypeScript + Vite + React Router。命令从本目录执行，依赖由 `package-lock.json` 固定；首次安装使用 `npm ci`，日常运行不重复安装。

## 源码分工

```text
src/
├─ main.tsx                 挂载入口
├─ app/App.tsx              登录、会话与顶层路由
├─ features/
│  ├─ albums/               独立相册库、城市/年份页面及共享业务类型
│  ├─ imports/              单图、批量导入和队列规则
│  ├─ photos/               原图浏览、文字、排序、移动、重复查看
│  ├─ map/                  中国市级地图、几何计算和公共数据加载
│  └─ trash/                回收站、删除确认和恢复
├─ shared/api.ts            HTTP、CSRF、会话隔离与原图读取
└─ styles/global.css        全局及现有功能样式
```

每个文件的具体用途见[文件导航](../docs/file-guide.md)。功能模块使用 `shared/api.ts` 请求服务；城市/影集类型放在 `features/albums/types.ts`，不从页面组件反向导入类型。全局样式仍集中在 `styles/global.css`；V2-01 统一白色背景及导航/相册排版，没有升级依赖或锁文件。

V2-01 在登录后的顶部提供“城市地图”和“我的相册”。`features/albums/AlbumLibrary.tsx` 负责独立 `/albums` 页面、分页返回位置及城市页面共用的封面卡片；列表读取 `GET /api/v1/me/albums`，默认年份倒序、未标年份置后。V2-04 相册查找子项增加城市/所属地区搜索、年份下拉和年份/最近整理排序；搜索显式提交，年份和排序即时应用，可组合使用并清除回默认。年份选项从 `GET /api/v1/me/albums/options` 读取本人的全部相册，不受已加载页数或搜索词限制。

筛选条件、已加载数量和位置只保存在当前账号的 `Journal` 内存，返回时按这些条件重读本人资料，不持久保存私人相册。切换条件清空旧结果并取消在途请求；失败重试保留条件，筛选无结果与从未创建相册分别提示。退出或换号清除记忆，迟到请求不能带回上一账号或上一条件的内容。接口与当前验证见[相册查找记录](../docs/reports/2026-10-23-album-library-filters.md)。

封面选择沿用照片列表和原图读取，调用 `PATCH /api/v1/albums/{id}/cover`；保留版本核对、失败后显式重读和恢复自动封面入口。具体边界见 [V2-01 记录](../docs/reports/2026-10-21-v2-album-library.md)。

V2-02/V2-03 将首页改为只绘制中国的市级 SVG 地图。`public/map-data/china-cities.v1.json` 提供全部已审核入口的公共几何，`mapService.ts` 按代码、名称、上级、单位类型关联 `/api/v1/map/cities`；本人照片填色仍读取 `/api/v1/me/atlas`。页面不再请求 `/map/config`、世界瓦片或在线逐市轮廓。`CityMap.tsx` 保留拖动、缩放、键盘、搜索定位与返回视角；路径按固定尺度记忆，移动时只更新变换。数据来源、固定版本及许可见[公共地图说明](public/map-data/NOTICE.md)，可重复生成脚本位于仓库 `scripts/build-china-map-data.py`。本次地图更新不新增迁移、依赖或锁文件变更。

V2-04 已完成首页改善子项：左侧地图画布桌面高度 540px（按用户反馈从 420px 增大），右侧为 320px 足迹栏，1100px 及以下改为上下布局，手机宽度不超过 480px 时画布保持 410px。`features/albums/HomeSidebar.tsx` 展示本人已点亮城市、相册与有效照片数，以及按相册更新时间排列的最近 3 本相册和快捷入口。`Journal.tsx` 用 `/me/albums?sort=recent&limit=3` 读取最近相册，并与足迹统计一起响应同页写入、跨窗口、窗口聚焦和页面重新可见；退出或换号取消请求。失败提供重试，不冒充空列表或零统计。普通滚轮在地图内缩放、在地图外滚页；地图也支持加减按钮或键盘缩放，保留拖动、定位和返回视角。达到缩放边界的按钮使用普通箭头，避免误显示等待光标。首页改善的历史范围见[首页记录](../docs/reports/2026-10-23-home-map-sidebar.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev -- --strictPort` | 本机开发服务器，代理 `/api` 到 8000 |
| `npm run build` | TypeScript 检查并生成 `dist/` |
| `npm run start:local` | 本机 5173 端口运行构建预览，需已有 `dist/` |
| `npm run lint` | ESLint 检查源码、测试与配置 |
| `npm run test:e2e` | 默认四组隔离回归；不启用重量级规模测试 |
| `npm run test:delivery` | 构建后用全新空库验收，并复用连续流程 |
| `npm run test:scale` | 显式运行重量级规模验证，先读[工具说明](../validation/scale/README.md) |

`npm run preview` 是 Vite 通用预览命令；日常优先用固定监听地址/端口的 `start:local`。完整启动、配置和更新见[本地手册](../docs/guides/local-first-release.md)。

## 测试分区

- `tests/e2e/`：业务、地图、独立相册和连续流程；也保留少量纯队列/几何/调度规则测试。`maps.spec.ts` 覆盖静态市界、地图内滚轮缩放、缩放边界光标及本人资料联动；`map-live.spec.ts` 现在默认验证随应用提供的真实公共资产，不访问在线地图服务或私有 Key。`library.spec.ts` 覆盖相册分页/返回、空态/失败/换号隔离、跨页封面选择与恢复自动；`library-filters.spec.ts` 覆盖城市/地区与年份组合、排序、完整年份选项、筛选分页及返回/错误/请求隔离。`home-sidebar.spec.ts` 覆盖双栏/窄屏、本人统计和最近相册、返回首页、错误/空态/换号及刷新联动。默认实际 Edge 无界面运行，PowerShell 设置 `$env:CITY_MEMORIES_EDGE_HEADED = '1'` 可显示窗口。
- `tests/delivery/`：构建资源、深链接、同源代理和端口占用检查；交付配置同时复用 `tests/e2e/journey.spec.ts`。
- `tests/scale/`：400/3000 张、双账号、浏览内存检查；不进入默认测试集合。

筛选测试示例：`npm run test:e2e -- tests/e2e/maps.spec.ts`。默认“既有业务 / 地图 / 连续流程 / 首页与相册”四组各自启动临时数据库/服务，避免共享测试账号触发累计登录限流；不要用一个服务替代全部分组。要求本机 Microsoft Edge、项目 Python 环境和空闲测试端口，不复用用户正在运行的服务。

测试默认使用 5173/8000。日常项目正在运行时，在同一测试终端设置 `$env:CITY_MEMORIES_E2E_FRONTEND_PORT = '5274'`、`$env:CITY_MEMORIES_E2E_BACKEND_PORT = '8174'`，可独立运行默认回归及 `test:delivery`；页面上下文与 Origin 均跟随实际测试地址，不连接用户服务。端口覆盖仅供测试，结束后移除这两个环境变量，不放入日常启动配置。

测试使用合成图片和隔离账号，结果不提交到公共仓库。旧 T13 在线瓦片核验属于历史证据，不能代替新图实际资产、覆盖和交互检查；地图结果见[中国地图记录](../docs/reports/2026-10-22-china-city-map.md)，首页结果见[首页改善记录](../docs/reports/2026-10-23-home-map-sidebar.md)，本次结果见[相册查找记录](../docs/reports/2026-10-23-album-library-filters.md)。目录整理后已迁移的旧测试路径见[整理记录](../docs/reports/2026-10-17-repository-organization.md)。
