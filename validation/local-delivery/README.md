# T16 本地构建版交付验收

从项目 `frontend` 目录执行 `npm run test:delivery`。需要现有 Python 3.13 项目虚拟环境、锁定前端依赖、Microsoft Edge，以及空闲的 8000/5173 端口。不使用全局 Python 包，不占用用户的 Edge 配置，不复用已有服务；端口占用直接失败。

命令先重新构建 `dist`，再启动本机 Vite 构建预览和正式 FastAPI 应用工厂。专用 `serve.py` 新建 `results/t16-runtime-*`，空库迁移后断言账号/影集/照片均为 0；没有预填充测试账号。数据目录覆盖为本轮临时路径；应用显式关闭地图 Key 和 Key 文件，保留正常认证、上传、清理与单实例保护。迁移仍沿用项目 Alembic 配置流程，不能拿此脚本当作私人服务启动器。

两组实际 Edge 检查：

1. 新的交付检查：初始空库及迁移头、浏览器版本、HTTP 实际 HTML 等于 `dist/index.html`、JS/CSS 字节匹配、无开发客户端、深链接与刷新、API 代理和未登录资源拒绝；另启动同参数预览子进程，确认端口占用返回 1 而非切换端口。该检查禁止外网请求。
2. 直接复用 `tests/e2e/journey.spec.ts`：两个新账号注册、空影集、批量合成原图、哈希、文字、排序、重复查看、跨城移动、删除恢复、越权拒绝和退出重登。复用测试标题中的 T14 是其原始来源，这次运行目标是 **T16 构建版 + 新建空库**，不是沿用旧运行结果。

`results/startup.json`、`build-manifest.json`、Playwright 截图及小型合成数据库仅本地保留；后一次运行覆盖同名记录，但产生新的运行目录。整个 results 已忽略，不提交数据库、认证密钥、Cookie、图片或原始日志。初始空库报告不是运行后的数量；验收中会产生两个合成账号和三份照片。没有给日常产品增加默认账号或额外测试 HTTP 接口。

该验收不注入真实地图 Key，不重复 T13 在线地图或 T15 3400 张重量级测试，也不代替正常停止/重启、备份故障和锁竞争的后端回归。测试框架退出时结束自己启动的服务；日常使用按手册 Ctrl+C 正常停机，不以强制终止作为操作步骤。

复验其他检查：

```powershell
# 工程根目录
backend\.venv\Scripts\ruff.exe check --config backend/pyproject.toml validation/local-delivery
# frontend 目录：额外检查不在应用 tsconfig 内的测试配置
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target es2023 --module esnext --moduleResolution bundler --skipLibCheck --strict --types node delivery/local.spec.ts playwright.delivery.config.ts
```

日常启动说明见 [本地第一版手册](../../docs/guides/local-first-release.md)，实测结果见 [T16 报告](../../docs/reports/t16-local-delivery-verification.md)。需要清理测试库时先停服务，只处理核对过的 results 直接子目录及 `t16-isolated.txt` 的 `synthetic-only` 标记，不使用通配递归删除，不触碰 `.local-data`。
