# 在开发软件里启动城影记

更新：2026-10-17。适用于本机 Windows；项目路径是 `D:\Workspace\city-memories`。这里只整理启动入口，不搬动源码、配置、数据库或照片，也不发布网站。

## 1. 用哪个软件

本机已安装 PyCharm 2026.2、IntelliJ IDEA 2026.2.0.1、VS Code 1.139.1 和 Cursor。日常推荐 **PyCharm**：项目已经用它打开，后端 Python 环境也已存在；不需要再装一套开发软件。

PyCharm 负责编辑和启动前后端，**Edge 负责使用网页**。运行窗口里的日志不是应用界面，不需要在 IDE 中寻找照片页面。

## 2. 日常启动：选择配置，点绿色三角

1. 在 PyCharm 选择“文件 → 打开”，打开整个 `D:\Workspace\city-memories` 文件夹，不要只打开 `backend` 或某个 `.py` 文件。本机已经打开时跳过这一步。
2. 右上角运行配置下拉框选择 **`城影记－启动`**，点击旁边绿色三角（运行，不是调试）。也可以按 `Alt+Shift+F10` 查看配置列表。
3. 下方“运行”窗口会有前后端两个进程。等后端出现 `Application startup complete`、前端出现 `http://127.0.0.1:5173/`；两者都成功后再打开页面。首次没有构建或更新过前端源码时，先按第 4 节构建。
4. 在 Edge 打开 **http://127.0.0.1:5173**。已有账号直接登录，没有账号再自行注册；没有默认账号。

配置从仓库 `.run/` 自动加载；刚拉取后没显示时，先按 `Ctrl+Alt+Y` 从磁盘同步项目文件，必要时重新打开项目。不要手动运行 `main.py`，也不需要每次复制命令。

**不要重复启动。** 若两个服务已经运行，直接打开网页；前端固定占用 5173，后端固定占用 8000，不自动改端口。不要同时打开旧的 PowerShell 启动实例和 IDE 实例。

## 3. 停止与下次再开

先保存文字和已经上传的照片，等待正在处理的操作结束。在 PyCharm 下方“运行”窗口分别停止 **后端** 和 **前端**（红色方块；支持“停止全部”时也可用）。等待后端显示 `Application shutdown complete`、两个进程退出后再关闭 IDE；不要连续强制结束进程。

Windows 的 npm 包装进程停止时可能短暂显示“终止批处理操作吗 (Y/N)?”，随后退出代码为 1；这是主动停止的结果，不表示启动失败。本机实测前端端口已释放；判断启动是否失败要看点击停止前的日志。若该提示一直停留，可在该运行窗口输入 `Y` 并回车，然后确认进程退出。

复合启动会同时启动两项，但不是依赖编排或后台服务：其中一项失败时另一项可能仍在运行，需检查两个窗口并停止遗留项再重试。关闭网页不等于停止服务；重启电脑后须重新点击运行。

## 4. 四个配置分别做什么

| 运行配置 | 用途 | 对应文件 |
| --- | --- | --- |
| 城影记－启动 | 并行启动以下前端和后端，日常选择它 | [local.run.xml](../../.run/local.run.xml) |
| 城影记－后端 | 项目 Python 环境以模块方式运行 Uvicorn，工作目录 `backend` | [backend.run.xml](../../.run/backend.run.xml) |
| 城影记－前端 | 在 `frontend` 执行 `npm run start:local`，读取已有 `dist` | [frontend.run.xml](../../.run/frontend.run.xml) |
| 城影记－前端构建 | 执行 `npm run build`，检查类型并生成页面，成功后正常退出 | [build.run.xml](../../.run/build.run.xml) |

首次无 `dist` 或修改过前端代码：先停止前后端 → 选择“城影记－前端构建”运行 → 确认 `Process finished with exit code 0` → 再选择“城影记－启动”。日常没有修改代码，不用每次构建。构建失败时先排错，不启动旧产物。

需要即时刷新开发时，可在 `frontend/package.json` 的 `dev` 脚本上右键运行，参数加 `--strictPort`；不要与构建版前端同时运行。第一次安装、锁文件依赖更新和数据库升级仍按[本地手册](local-first-release.md#3-新机器首次准备或更新后)，运行按钮不会偷偷安装依赖、迁移数据库或重建数据。

## 5. 解释器与常见问题

- Python 配置已经指向 **项目自己的** `backend\.venv\Scripts\python.exe`，工作目录为 `backend`。不要改成本机裸 `python`（它可能指向 MSYS2），也不要创建第二个虚拟环境。其他操作系统需自行调整解释器路径。
- npm 配置使用 PyCharm 的项目 Node.js 运行时。本机 Node 位于 `D:\SDK\Node\node.exe`，npm 位于 `D:\SDK\Node\npm.cmd`。若提示没有 Node，进入“设置 → 语言和框架 → Node.js”，选择这个现有 Node 和 npm；不下载、不安装到全局。
- 如果提示找不到 `uvicorn` 或 `city_memories`，先核对上面的 Python 路径，再按本地手册从锁文件同步项目环境，不要全局 `pip install`。
- 如果出现端口占用，先停止自己已经开启的旧实例；不杀死未知进程，不改端口绕过问题。
- 如果页面提示服务不可用，先看后端是否完成启动；如果显示旧页面，先重新构建再刷新。
- 本机已看到 npm 运行类型；其他机器的 PyCharm npm/Node 功能可能要求 Pro。如果不可用，不需要为此购买或开启试用：用[原有 PowerShell 启动方式](local-first-release.md#2-这台电脑日常怎么启动)，终端也可以开在 VS Code、Cursor 或 PyCharm 内，命令和目录相同。

共享运行配置使用 `$PROJECT_DIR$`，不包含本机账号或密钥。个人 IDE 布局、历史等仍在忽略的 `.idea/`；不要把整份 `.idea` 上传。

## 6. 数据和安全边界

运行按钮与原命令启动的是同一个应用：继续使用根目录私有 `.env` / `CITY_MEMORIES_` 环境变量及配置的数据目录，**不会创建测试账号，不会清空数据库**。环境变量优先于 `.env`，不要在日常配置中保留测试用数据路径。

正常后端启动仍会按现有规则恢复未完成状态，并清理已到期回收站等资料；这不是备份功能。私人照片、数据库、Key 仍留本机。测试必须使用隔离数据，不把日常配置当测试入口。

服务只监听本机，不开防火墙、不创建开机启动、不改安全软件设置；Vite 预览不适用于公网部署。备份和恢复继续看[备份指南](backup-restore.md)。

参考：[JetBrains 共享运行配置](https://www.jetbrains.com/help/pycharm/run-debug-configuration.html)、[Python 配置](https://www.jetbrains.com/help/pycharm/run-debug-configuration-python.html)、[npm 配置](https://www.jetbrains.com/help/pycharm/run-debug-configuration-npm.html)、[复合运行配置](https://www.jetbrains.com/help/pycharm/run-debug-multiple.html)。
