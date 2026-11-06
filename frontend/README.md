# 此间集前端

React + TypeScript + Vite 工程，依赖版本以 [package.json](package.json) 和锁文件为准。以下命令均从 `frontend/` 执行；日常按钮启动见[PyCharm 指南](../docs/guides/ide-startup.md)，用户操作见[功能指南](../docs/guides/user-guide.md)。

## 从哪里读代码

| 位置 | 职责 |
| --- | --- |
| [src/main.tsx](src/main.tsx)、[src/app/App.tsx](src/app/App.tsx) | 挂载页面、登录/注册、会话与连接状态、账号切换清理 |
| `src/features/albums/` | 首页、城市相册库、城市内年份影集、本人足迹和最近整理 |
| `src/features/imports/` | 统一添加照片、批次队列与重试；保留旧单张任务恢复 |
| `src/features/account/` | 登录后的修改密码表单、错误反馈及未知结果转登录核对 |
| `src/features/map/` | 公共中国地图、城市定位、交互与资料加载 |
| `src/features/photos/`、`src/features/trash/` | 原图查看、文字/顺序/移动、重复查看和回收恢复 |
| `src/shared/`、`src/styles/` | API 请求、共享操作提示及全站样式 |
| [public/map-data/NOTICE.md](public/map-data/NOTICE.md) | 地图来源、固定版本和许可 |
| `tests/`、`scripts/` | 业务/交付/规模测试，以及隔离分组启动器 |

完整逐文件说明见[文件导航](../docs/file-guide.md#前端)。

## 当前页面与数据流

主要浏览层级是 `/albums` 城市卡 → `/cities/:cityId` 年份影集 → `/albums/:albumId` 照片。城市入口默认请求 34 个省级默认城市，有搜索词时查询全国已审核目录。

页面经 `shared/api.ts` 访问同源 `/api/v1`，本机 Vite 代理到后端。城市相册由后端聚合，首页最近整理仍读取年份影集；城市卡的年份筛选只决定是否入选，不把统计和封面缩成单一年份。

地图读取随应用提供的公共矢量及已审核城市目录，点亮与计数来自当前账号的足迹接口；无需在线地图 Key。加载失败提供重试，不把未知统计当成零。

## 修改时保留的规则

- 添加一张、多张或拖入照片都从“添加照片”进入 `BatchImport`；`UploadPanel` 只用于已有 `?import=` 任务兼容。
- 上传与明确保存是两步；结果不明先查询或同参数重试，不另建队列掩盖失败。原图按需读取、离开视野释放，不生成缩略图。
- 保存备注、排序、移动、换封面及回收/恢复均遵守后端版本与幂等规则，不能静默覆盖冲突。
- 注册密码策略在 `shared/passwords.ts`，与后端保持一致；登录兼容旧密码，不能套用新注册字符/弱密码限制，详见[账号契约](../docs/architecture/data-api-design.md#3-注册与会话)。
- 表单字段校验和注册错误白名单在 `shared/authFields.ts`：首次提交后才显示，错误与对应输入关联并定位首错；通用登录/服务错误保持表单级，不猜测哪项凭据错误。
- `/account/password` 通过当前密码主动改密，`expected_user_id` 防止跨标签换号误改；成功或未知结果转登录时启用 App 内存中的显式登录门禁。未知结果不自动重放，整页重新加载仍按服务器当前会话核对。
- 认证等待与恢复由 `shared/auth.ts` 和 `App.tsx` 协调：每次操作总等待 15 秒，覆盖 CSRF 准备及响应正文；结果不明只提供核对/显式重试，不自动重放写请求。通用照片与上传请求不套用此期限。
- 筛选、展开状态和返回位置保留在当前账号内存；换号/退出取消请求并清除旧内容。后台会话暂时核对失败可保留当前页，确认失效则隐藏私人内容。
- 手机默认滑动页面，明确开启“移动地图”后才拖动地图；普通鼠标滚轮在地图内缩放、外部滚页。

字段、错误码和接口约定见[数据与接口设计](../docs/architecture/data-api-design.md)。历史改动与测试结果见[报告索引](../docs/reports/README.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 首次准备或锁文件变化时安装锁定依赖，日常不重复执行 |
| `npm run dev -- --strictPort` | 源码开发与即时刷新，默认本机 5173 |
| `npm run build` | TypeScript 检查并生成 `dist/` |
| `npm run start:local` | 在 127.0.0.1:5173 预览已构建页面，不自动重新构建 |
| `npm run lint` | 检查源码、测试与配置 |
| `npm run test:e2e` | 默认六组隔离回归 |
| `npm run test:delivery` | 构建后使用全新空库验收 |
| `npm run test:scale` | 显式重量级规模验证，先读[工具说明](../validation/scale/README.md) |

开发服务器与构建预览不能同时占用 5173。完整安装、迁移和更新分流见[本地手册](../docs/guides/local-first-release.md#3-新机器首次准备或更新后)。

## 隔离测试

测试需要本机 Microsoft Edge、项目 Python 环境及空闲端口，使用临时库和合成照片，不复用日常服务。默认六组为“既有业务 / 认证专项 / 导入 / 地图 / 连续流程 / 首页与相册”，每组重建独立服务；不要合并后削弱正式限流。认证专项包含字段提示、修改密码与异常恢复，覆盖真实提交后响应丢失，不挤占其他组的认证配额。

| 目录 | 覆盖 |
| --- | --- |
| `tests/e2e/` | 账号、导入、整理、地图、相册与连续流程；含少量纯队列/几何规则检查 |
| `tests/delivery/` | 构建资源、深链接、代理与端口冲突；交付配置同时复用连续流程 |
| `tests/scale/` | 400/3000 张与两账号并发等规模验证，不进入默认回归 |

在独立测试终端使用空闲端口，避免与日常 5173/8000 冲突。例如只验证认证：

```powershell
$env:CITY_MEMORIES_E2E_FRONTEND_PORT = '5274'
$env:CITY_MEMORIES_E2E_BACKEND_PORT = '8174'
try {
    npm run test:e2e -- tests/e2e/auth.spec.ts
    if ($LASTEXITCODE -ne 0) { throw '认证回归未通过' }
} finally {
    Remove-Item Env:CITY_MEMORIES_E2E_FRONTEND_PORT, Env:CITY_MEMORIES_E2E_BACKEND_PORT -ErrorAction SilentlyContinue
}
```

完整回归使用 `npm run test:e2e`，构建版使用 `npm run test:delivery`，两者都支持上述端口覆盖。默认回归的 Edge 无头运行，设置 `CITY_MEMORIES_EDGE_HEADED=1` 可显示窗口；交付验收使用可见 Edge。

测试结果写入忽略目录，可按工具说明重新生成；不提交截图、运行数据库、Cookie 或网络 trace。实际通过项与未测范围以各次报告为准。
