import { defineConfig } from '@playwright/test'

function testPort(name: string, fallback: number) {
  const port = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid ${name}`)
  return port
}
const frontendPort = testPort('CITY_MEMORIES_E2E_FRONTEND_PORT', 5173)
const backendPort = testPort('CITY_MEMORIES_E2E_BACKEND_PORT', 8000)

// Built frontend + a genuinely empty, isolated database. No pre-seeded accounts.
// Reuse T14's self-contained journey without repeating its test implementation.
export default defineConfig({
  testDir: './tests',
  testMatch: ['delivery/local.spec.ts', 'e2e/journey.spec.ts'],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: '../validation/local-delivery/results/browser',
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    channel: 'msedge', headless: false,
    viewport: { width: 1360, height: 940 },
    trace: 'off',
  },
  webServer: [
    {
      command: '..\\backend\\.venv\\Scripts\\python.exe ..\\validation\\local-delivery\\serve.py',
      url: `http://127.0.0.1:${backendPort}/api/v1/health`,
      reuseExistingServer: false, timeout: 30_000,
    },
    {
      command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${frontendPort} --strictPort`, url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false, timeout: 30_000,
    },
  ],
})
