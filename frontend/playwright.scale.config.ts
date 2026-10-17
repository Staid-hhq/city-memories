import { defineConfig } from '@playwright/test'

// Explicit opt-in command; never runs against .local-data or an existing server.
export default defineConfig({
  testDir: './tests/scale',
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: '../validation/scale/results/browser',
  use: {
    baseURL: 'http://127.0.0.1:5173', channel: 'msedge', headless: false,
    viewport: { width: 1360, height: 940 }, trace: 'off',
  },
  webServer: [
    { command: '..\\backend\\.venv\\Scripts\\python.exe ..\\validation\\scale\\serve.py' +
        (process.env.CITY_MEMORIES_SCALE_RESUME === '1' ? ' --resume' : ''),
      url: 'http://127.0.0.1:8000/api/v1/health', reuseExistingServer: false, timeout: 30_000 },
    { command: 'npm run dev -- --strictPort', url: 'http://127.0.0.1:5173',
      reuseExistingServer: false, timeout: 30_000 },
  ],
})
