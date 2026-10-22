import { defineConfig } from '@playwright/test'

function testPort(name: string, fallback: number) {
  const port = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid ${name}`)
  return port
}
const frontendPort = testPort('CITY_MEMORIES_E2E_FRONTEND_PORT', 5173)
const backendPort = testPort('CITY_MEMORIES_E2E_BACKEND_PORT', 8000)

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    channel: 'msedge',
    headless: process.env.CITY_MEMORIES_EDGE_HEADED !== '1',
    viewport: { width: 1360, height: 940 },
    trace: 'off', // 认证测试不记录含密码和 Cookie 的网络 trace。
  },
  webServer: [
    {
      command: '..\\backend\\.venv\\Scripts\\python.exe ..\\backend\\tests\\serve_e2e.py',
      url: `http://127.0.0.1:${backendPort}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npm run dev -- --strictPort --port ${frontendPort}`,
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
