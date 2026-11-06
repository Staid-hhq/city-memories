# T02 注册、登录与授权基础

日期：2026-09-22。状态：已完成。当前代码可自行注册、登录、退出，重启后继续使用原账号。登录后暂时显示本人账号的手帐入口，城市年份页从 T03 开始实现。

## 实际数据流

页面先取得短期匿名会话和 CSRF Token；注册将 Argon2 哈希写入 SQLite，随后返回登录页。登录成功时撤销旧会话、创建新会话，浏览器通过 HttpOnly Cookie 携带随机会话标识；数据库只保存其 SHA256 摘要。`GET /api/v1/auth/me` 根据服务端会话返回本人资料，不接受请求中的 owner_id 作为身份。退出先隐藏私人页面并取消在途请求，服务端撤销会话后才显示退出成功；网络失败时提示重试。其他窗口通过无凭据的 BroadcastChannel 通知重新核验身份。

## 配置与开发边界

- 用户名 3–32 位 ASCII 字母、数字、下划线，转小写判重；密码 15–128 个 Unicode 字符，不 trim、不截断，确认密码不保存。没有默认账号。
- 匿名会话 1 小时，登录会话绝对有效期 7 天；退出/到期后每次请求立即拒绝，不依赖后台清理。
- 修改请求统一校验可信 Origin/Referer 和会话匹配的 CSRF Token。所有 API 响应 `private, no-store`，错误含请求 ID、不含密码或数据库详情。
- 限流采用数据库固定窗口：账号键 15 分钟最多 10 次失败；每来源 15 分钟最多 60 次登录；注册每来源每小时 5 次；匿名会话每来源每小时最多签发 60 次。复用有效匿名会话不耗签发次数，429 带 Retry-After。
- 限流键保存 HMAC 摘要，密钥默认首次启动时写入私有目录的 `auth-secret.key`，重启沿用，也可由环境变量注入。认证操作在单实例内序列化，哈希运算不占数据库事务；不支持多 worker 绕过该协调机制。
- 按 README 使用 `--no-proxy-headers` 启动。实际来源为连接地址，不直接信任任意 X-Forwarded-For。Vite 本地代理下浏览器共享回环来源的限额。
- 认证 JSON 请求体限制为 16 KiB，在解析前按实际接收字节计数。用户密码字段在校验错误中也不会回显。
- 本机 HTTP 使用非 Secure Cookie；HTTPS 部署必须设 `CITY_MEMORIES_COOKIE_SECURE=true` 并配置正式来源。该部署尚未执行。
- `.env.*`、私有原图/数据库/密钥、Edge 测试截图和报告均被 Git 忽略。配置样例只有占位内容；测试没有读取源照片。

## 已执行的验证

| 范围 | 实际结果 |
| --- | --- |
| Python / 后端 | Python 3.13.14；pytest `58 passed`，Ruff 通过 |
| 账号与口令 | 注册不自动登录、重名含大小写变化不覆盖、错误/不存在账号统一提示、Argon2、空格/中文不被改写、输入边界和错误不回显密码 |
| 会话与 CSRF | 会话及 CSRF 轮换、同会话 Token 稳定、旧 Cookie 拒绝、绝对过期、HttpOnly/SameSite/Path/Secure；三种写接口分别验证缺 Token、错误 Token、他人 Token、缺来源、伪造来源及跨站请求 |
| 身份隔离 | 两独立客户端各自只能从 me 取得本人资料；篡改 owner_id/user_id 不改变身份；一个账号退出不影响另一账号 |
| 持久化 | 应用重建后账号、密钥、会话和限流仍有效；另外实际启动、停止并两次重启 Uvicorn，确认原账号可登录、旧会话被撤销后仍失效 |
| 限流与并发 | 账号、来源、注册、匿名签发额度及窗口到期；伪造 X-Forwarded-For 无效；14 个并发错误登录只有 10 次进入密码失败，其余 429；并发重名注册只成功一次，同一旧会话只能登录轮换一次 |
| 数据基础 | 空库迁移、每连接外键/WAL、真实 INSERT 后回滚、WAL 写入期间旧读事务保持快照；存储故障返回 503 |
| 前端工程 | ESLint、TypeScript、Vite 生产构建通过；Playwright 1.63.0 锁入 package-lock.json |
| 实际 Edge | Windows，Microsoft Edge 153.0.4234.48，headless，1360×940；3 组回归通过，登录页截图已目视核对 |
| Edge 流程 | 注册→错误密码→网络失败→登录→重载→退出→后退不残留；重名错误；两个独立账号与同账号两窗口退出/切换；密码确认不一致；退出网络失败隐藏私人页且能重试 |

所有用户、口令和数据库均为临时测试样本。测试创建独立临时服务；Edge 测试网络 trace 关闭，避免把口令和 Cookie 存到测试追踪文件。截图仅保存在被忽略的 `frontend/test-results/` 中。测试服务随测试结束停止。

后端测试依赖出现两条上游弃用提醒（Starlette 对 httpx 的迁移提醒、anyio BlockingPortal 别名），未影响通过结果；本次未因提醒扩大升级范围。没有运行照片功能、全国地图、400/3000 规模或完整 T14 回归；这些仍按原任务计划验证。原图地址和影集资源的 404 归属检查须在具体接口实现时补测。

## 可复现命令

先按项目 README 安装锁定依赖，以下后端命令在 `backend/` 执行：

```powershell
uv run ruff check .
uv run pytest -q
```

前端命令在 `frontend/` 执行：

```powershell
npm run lint
npm run build
npm run test:e2e
```

Edge 测试需要本机安装 Microsoft Edge，且 8000、5173 端口空闲。测试不会复用正在运行的用户服务，也不加载现有数据目录。若 uv 缓存权限受限，可对当前命令使用 `uv --cache-dir .uv-cache run ...`，或直接运行项目 `.venv/Scripts/` 下的已安装工具。

## 实现参考

沿用项目已选方案，核对 [FastAPI 的 pwdlib/Argon2 用法](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/)；仅采用其中密码哈希部分。CSRF 的服务端 Token 和来源检查参考 [OWASP 指南](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。Python 3.13 事务模式与 PRAGMA 设置参考 [SQLAlchemy 2.0 SQLite 文档](https://docs.sqlalchemy.org/en/20/dialects/sqlite.html)。
