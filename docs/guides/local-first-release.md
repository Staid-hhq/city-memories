# 本地第一版使用手册（T16）

更新：2026-10-21。适用 Windows、PowerShell、Microsoft Edge；工程位于 `D:\Workspace\city-memories`。其他电脑须改成自己的工程路径，并准备同版本依赖。本页沿用 T16 的本地启动方式，并补充 V2-01 升级步骤；当前仍**仅本机使用**，不是公开网站、安装程序或 Windows 后台服务。

## 1. 先知道哪些资料在哪里

- 源码：工程目录；GitHub 只同步代码与文档，不备份账号、文字或照片。
- 私有配置：工程根目录 `.env` 和 `CITY_MEMORIES_` 环境变量。环境变量优先；已有 `.env` 不覆盖、不上传。
- 默认数据：工程下 `.local-data/`；实际位置以 `CITY_MEMORIES_DATA_DIR` 的配置为准。
- 数据目录内部：`database/city-memories.sqlite3` 及运行时 WAL/SHM、`originals/` 原字节独立副本、`staging/` 未保存上传、`auth-secret.key` 随机认证密钥、`maintenance.lock` 单实例锁文件。
- 构建页面：`frontend/dist/`，可重新生成，不是照片保存位置。测试资料位于临时目录或 Git 忽略的 `validation/.../results/`，不作为日常数据。

不要手动修改数据库、清空 originals/staging、删除运行中的锁文件，或把数据放进前端静态目录、Git、自动同步目录。默认 `.local-data` 已忽略，但这不等于独立备份。

## 2. 这台电脑日常怎么启动

现在也可以直接在 **PyCharm** 选择“城影记－启动”并点击运行，无需每天手动输入命令，见[软件内启动指南](ide-startup.md)。两种启动方式使用同一份数据，不要同时运行。

首次从第一版升级 V2-01 时，先按第 3 节正常停机、备份并显式执行数据库升级，再构建前端；运行按钮不会自动迁移。开发验证只升级了合成测试库，没有升级用户真实数据库。

本机 T16 已准备依赖和构建。正常使用只需两个 PowerShell 终端，**不要重复启动已有实例**。开始前确保上次上传已保存，若服务已经运行，直接打开网页即可。

终端 A：后端（账号、数据库、原图与清理）

```powershell
Set-Location 'D:\Workspace\city-memories\backend'
& .\.venv\Scripts\python.exe -m uvicorn city_memories.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers --no-access-log
```

等待出现 `Application startup complete` 和 `Uvicorn running on http://127.0.0.1:8000`。不要加 `--workers`，日常使用无需 `--reload`。

终端 B：本地构建版页面

```powershell
Set-Location 'D:\Workspace\city-memories\frontend'
npm run start:local
```

Edge 打开 **http://127.0.0.1:5173**。统一使用这个地址，不与 localhost 混用；不同主机名的 Cookie 不共享。8000 是后端，不是主页面。两个终端都要保持运行，关掉终端或重启电脑后须重新启动。

`start:local` 读取已经生成的 `dist`，沿用同源 `/api` 代理到 8000，固定监听 `127.0.0.1:5173`；端口被占用即退出，不悄悄换端口。它使用 Vite 的**本地构建预览**，不是互联网生产服务器，不要绑定 `0.0.0.0`、开放路由器端口或用隧道发布。正式部署另按 T17 完成 HTTPS、域名、访问和维护配置。[Vite 官方说明](https://vite.dev/guide/static-deploy.html)

若提示没有构建文件，或刚更新过前端代码，先在终端 B 执行：

```powershell
npm run build
if ($LASTEXITCODE -ne 0) { throw '构建失败，先排查，不启动旧产物' }
npm run start:local
```

开发时可用 `npm run dev -- --strictPort`，但不能与构建预览同时占用 5173；修改源码后，构建预览不会自动更新，须重新 build。

## 3. 新机器/首次准备或更新后

这一节不是每天都要执行。准备 Node 24、Python 3.13、uv 和 Edge；沿用 `package-lock.json` / `uv.lock`，不要为启动项目更新全部依赖或安装到全局。T16 的已验证版本见 [验收记录](../reports/t16-local-delivery-verification.md)。

先正常停止已有服务。若使用的是有资料的目录，先按第 7 节做一致备份；不要边运行边迁移、切目录或同步虚拟环境。

在 backend 准备锁定依赖：

```powershell
Set-Location 'D:\Workspace\city-memories\backend'
# 此 Python 路径是这台电脑现有安装；其他机器应使用自己的 Windows Python 3.13 路径。
uv sync --locked --python 'D:\SDK\Python\Python3.13\python.exe' --cache-dir .uv-cache
if ($LASTEXITCODE -ne 0) { throw '后端依赖未就绪' }

# 只打印实际数据目录，不输出整份配置或密钥。确认这是要使用的目录。
& .\.venv\Scripts\python.exe -c "from city_memories.config import Settings; print(Settings().data_dir.resolve())"
```

确认路径后再迁移：

```powershell
& .\.venv\Scripts\python.exe -m alembic upgrade head
if ($LASTEXITCODE -ne 0) { throw '迁移未完成，不要继续启动' }
& .\.venv\Scripts\python.exe -m alembic current
```

当前迁移头为 `c7e9a162b4d8`，新增可空的相册封面偏好，旧行默认自动选封面。已有项目环境时，从 `backend` 目录使用 `& .\.venv\Scripts\python.exe -m alembic upgrade head` 即可显式升级；确认退出码为 0 后再启动，PyCharm 运行按钮不会自动执行。迁移不会导入默认账号或私人照片。不要把备份目录作为应用数据目录迁移；旧版恢复目录仍保留旧 schema，应按[恢复说明](backup-restore.md#3-恢复到全新目录并检查)指向新目录、升级后再启动新版。

在 frontend 安装锁定依赖并构建：

```powershell
Set-Location 'D:\Workspace\city-memories\frontend'
npm ci
if ($LASTEXITCODE -ne 0) { throw '前端依赖未就绪' }
npm run build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
```

然后按第 2 节启动。首次下载缺失依赖需要网络；已有 Python 依赖不代表构建工具已经缓存，离线同步失败时不要删除原环境。`uv sync --locked --check --offline --cache-dir .uv-cache` 可检查现有环境是否与锁定项目一致。普通 Windows Python 操作使用 `.venv\Scripts\python.exe`，不要误用本机裸 `python` 指向的 MSYS2。

以后更新源码：先停止、备份、检查 `git status`，干净时正常快进拉取，再按锁文件同步依赖、迁移和 build。遇到本地改动或分叉先核对，不使用 `reset --hard` 或强制覆盖。

## 4. 第一次使用与最小自检

1. 点注册，自己设置账号。用户名 3–32 位英文字母、数字或下划线；密码 15–128 个字符，可含中文和空格。没有默认账号，不要沿用测试代码中的合成密码。
2. 登录，搜索城市，创建年份或未标年份影集。空影集会保存，但不会点亮地图。
3. 先选一两张不敏感图片试用。单张 JPEG/PNG/静态 WebP，最多 50 MiB、8000 万像素；不支持 HEIC/RAW/动画，不自动转码。
4. 上传校验后明确“保存到影集”；批量页则先核对文件、年份和顺序，再上传并“保存本批全部照片”。100% 传输不等于已经保存。
5. 返回影集打开原图，保存一段文字；退出重登，核对数量和文字。源文件不会被移动或改写，系统保存独立原字节副本。
6. 正常停止并重启后，再打开原影集检查。不要为了测试持久化删除或搬动真实源照片。

完整的排序、跨影集移动、重复查看、回收站及异常恢复入口见 [功能使用指南](user-guide.md)。重复内容默认保留；移入回收站只处理选中副本，不替你选择或自动去重。

## 5. 配置规则

一般无需新建配置或提供认证密钥。需要配置时参照 [占位示例](../../backend/.env.example)，手动补充到**工程根目录** `.env`，不是 backend 下；不要覆盖已有文件或把密钥写进前端 `VITE_*` 变量。

| 配置 | 本地用法 |
| --- | --- |
| `CITY_MEMORIES_DATA_DIR` | 默认 `.local-data`。改动只会选择另一数据目录，不会自动搬迁旧资料；使用绝对、本地、私有路径，不使用链接/junction/网络共享 |
| `CITY_MEMORIES_ALLOWED_ORIGINS` | JSON 数组，默认允许 127.0.0.1/localhost 的 5173、8000 来源。不要随意放宽；本手册固定使用 127.0.0.1 |
| `CITY_MEMORIES_COOKIE_SECURE` | 本机 HTTP 为 false；未来 HTTPS 部署必须复核，不能直接照搬为公网配置 |
| `CITY_MEMORIES_AUTH_SECRET` | 可不设置；系统在数据目录随机生成并复用密钥，禁止复制到源码、日志或公开截图 |
| `CITY_MEMORIES_CLEANUP_ENABLED` / `...INTERVAL_SECONDS` | 默认 true / 60；启动补做清理，每轮完成后等待。关闭不是备份，也不会延长回收站期限 |
| `CITY_MEMORIES_MAP_KEY` 或 `...MAP_KEY_FILE` | 现有受保护配置继续使用，无需重新发送 Key；其他机器自己配置，不上传配置文件 |
| `CITY_MEMORIES_MAP_REVIEW_NUMBER` / `...MAP_REVIEW_DATE` | 按实际官方来源核对填写，不能把底图信息当成本应用已获审图通过 |

配置改变后重启后端。环境变量只在设置它的终端及其子进程生效；不同终端可能指向不同数据目录，切换前务必核对。不要在启动命令中明文填写密码或 Key。

地图无配置或外网不可用时，会显示明确提示，城市搜索与私人影集仍可使用。391 个入口已审核，草湖市暂未开放。运行时浏览器 Key 对已登录浏览器可见，不进 Git 不等于浏览器完全不可见；正式域名限制和服务条件属于 T17。

## 6. 正常停止与常见问题

先确认上传已提交、文字已保存；再在后端终端按 `Ctrl+C`，等待正常退出，最后在前端终端按 `Ctrl+C`。不要强杀正在保存或清理的进程。测试工具的进程结束不代替日常正常停机。

| 现象 | 处理 |
| --- | --- |
| 5173/8000 端口占用 | 先检查是否已经启动；正常停止你确认属于本项目的旧实例，不结束不认识的进程，不通过换端口绕过问题 |
| 页面打开但登录/上传失败、代理连接失败 | 确认终端 A 已启动完成，浏览器地址为 127.0.0.1:5173；检查后端汇总错误，不分享含凭据的网络日志 |
| 缺表或启动时数据库异常 | 正常停机、确认数据目录、检查迁移是否成功；已有真实资料先备份，不通过删除数据库“修复” |
| 缺少 dist 或仍是旧界面 | 停止前端，确保 build 成功再启动；不要双击 dist/index.html 作为独立离线网页 |
| 403/CSRF 或登录后立刻失效 | 确认主机名、来源配置以及本机 HTTP 的 Cookie 配置；不用 localhost/127.0.0.1 混合标签页 |
| `MAINTENANCE_BUSY` 或单实例锁冲突 | 正常停止现有后端、迁移或备份；等在途任务结束，不手动删锁文件 |
| 看不到以前的账号或照片 | 先核对实际数据目录及当前账号，不覆盖旧目录、不注册同名账号冒充恢复、不移动原图文件 |
| 上传失败/结果不明 | 保留文件，先查询已保存结果；按页面逐项重试或重新选择未传完文件，不重复创建整批掩盖故障 |
| 清理失败提示 | 检查磁盘、权限、文件占用；解除后自动重试。到期仍禁止读取，不承诺恢复已永久清理的副本 |
| npm.ps1 被系统策略阻止 | 可使用同安装目录的 `npm.cmd`；不要为运行项目全局关闭安全策略 |

忘记密码目前没有邮件找回或管理员重置页面；不要手工改密码哈希。备份保留原账号密码哈希，恢复不是密码重置。

## 7. 备份与恢复：首次正式存重要照片前落实

已交付离线 `create / verify / restore` 工具，**尚未替你备份真实资料**。先确定独立、受保护的介质、执行频率、保留份数和定期恢复演练；同一物理硬盘的另一个盘符不算独立介质。

操作顺序：正常停止后端 → 用实际数据目录创建新备份 → 完整校验 → 重启原服务。恢复则先校验可信备份 → 写入全新目录 → 核对账号、归属、数量、原图、文字、顺序及期限 → 决定是否正式切换。**不覆盖旧库，不合并，不删除旧好备份。**

完整可替换路径的命令、失败排查和维护边界只维护在 [一致备份与恢复操作说明](backup-restore.md)，避免两套命令不一致。备份含私人图片、文字和密码哈希，没有内置加密、自动轮换或定时任务；不要上传公开仓库。认证密钥和 `.env` 不包含在备份里，恢复后旧登录会话失效。

回收站保留 30×24 小时，到期立即禁止读取/恢复，服务启动及运行时会自动永久清理系统副本。GitHub、回收站、同硬盘副本都不能代替独立备份。

## 8. 交付范围与复验

- 已交付：本机账号、城市/年份影集、原图导入与查看、文字/排序/移动、重复查看、回收站恢复、到期清理、离线一致备份及正式地图资料接入。
- 已测范围：T14 完整流程，T15 400/3000 不同合成原图及两账号并发。不是十人长期容量、所有 50 MiB/80MP 极端图片、断电、硬盘损坏或公网传输承诺。
- 尚未交付：公开 HTTPS 网站、跨电脑访问、手机专门适配、域名/主机/费用方案、真实介质备份策略；T17 待安排。没有购买服务、开防火墙或创建开机启动。
- 此次构建保留在本机 `frontend/dist`，GitHub 保存可复现源码、锁文件及手册；不上传原图、数据目录、真实地图响应、运行记录或构建中的私有配置。

常规检查在 backend 执行 `uv run python -m pytest -q`、`uv run ruff check .`；frontend 执行 `npm run lint`、`npm run build`、`npm run test:e2e`。构建版空库验收在 frontend 执行 `npm run test:delivery`，使用独立可见 Edge、空测试库与合成图片，不使用你的账号。详见 [T16 验收记录](../reports/t16-local-delivery-verification.md) 及 [隔离验收工具](../../validation/local-delivery/README.md)。
