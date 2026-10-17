# 城影记前端

React 19 + TypeScript + Vite + React Router。命令从本目录执行，依赖由 `package-lock.json` 固定；首次安装使用 `npm ci`，日常运行不重复安装。

## 源码分工

```text
src/
├─ main.tsx                 挂载入口
├─ app/App.tsx              登录、会话与顶层路由
├─ features/
│  ├─ albums/               城市、年份影集页面及共享业务类型
│  ├─ imports/              单图、批量导入和队列规则
│  ├─ photos/               原图浏览、文字、排序、移动、重复查看
│  ├─ map/                  地图页面、几何计算和请求调度
│  └─ trash/                回收站、删除确认和恢复
├─ shared/api.ts            HTTP、CSRF、会话隔离与原图读取
└─ styles/global.css        全局及现有功能样式
```

每个文件的具体用途见[文件导航](../docs/file-guide.md)。功能模块使用 `shared/api.ts` 请求服务；城市/影集类型放在 `features/albums/types.ts`，不从页面组件反向导入类型。暂不拆分现有全局 CSS，以免只整理目录却改变样式优先级。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev -- --strictPort` | 本机开发服务器，代理 `/api` 到 8000 |
| `npm run build` | TypeScript 检查并生成 `dist/` |
| `npm run start:local` | 本机 5173 端口运行构建预览，需已有 `dist/` |
| `npm run lint` | ESLint 检查源码、测试与配置 |
| `npm run test:e2e` | 默认三组隔离回归；不启用重量级规模测试 |
| `npm run test:delivery` | 构建后用全新空库验收，并复用连续流程 |
| `npm run test:scale` | 显式运行重量级规模验证，先读[工具说明](../validation/scale/README.md) |

`npm run preview` 是 Vite 通用预览命令；日常优先用固定监听地址/端口的 `start:local`。完整启动、配置和更新见[本地手册](../docs/guides/local-first-release.md)。

## 测试分区

- `tests/e2e/`：业务、地图和连续流程；也保留少量纯队列/几何/调度规则测试。默认实际 Edge 无界面运行，PowerShell 设置 `$env:CITY_MEMORIES_EDGE_HEADED = '1'` 可显示窗口。
- `tests/delivery/`：构建资源、深链接、同源代理和端口占用检查；交付配置同时复用 `tests/e2e/journey.spec.ts`。
- `tests/scale/`：400/3000 张、双账号、浏览内存检查；不进入默认测试集合。

筛选测试示例：`npm run test:e2e -- tests/e2e/albums.spec.ts`。默认分组各自启动临时数据库/服务，避免共享测试账号触发累计登录限流；不要用一个服务替代全部分组。要求本机 Microsoft Edge、项目 Python 环境和空闲的 8000/5173 端口，不复用用户正在运行的服务。

真实地图在线用例默认跳过；未经专门安排不要开启，以免读取本机 Key 或消耗配额。测试使用合成图片和隔离账号，结果不提交到公共仓库。目录整理后已迁移的旧测试路径见[整理记录](../docs/reports/2026-10-17-repository-organization.md)。
