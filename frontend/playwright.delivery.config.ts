import { defineConfig } from '@playwright/test'

// Built frontend + a genuinely empty, isolated database. No pre-seeded accounts.
// Reuse T14's self-contained journey without repeating its test implementation.
export default defineConfig({
  testDir: '.',
  testMatch: ['delivery/local.spec.ts', 'tests/journey.spec.ts'],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: '../validation/local-delivery/results/browser',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'msedge', headless: false,
    viewport: { width: 1360, height: 940 },
    trace: 'off',
  },
  webServer: [
    {
      command: '..\\backend\\.venv\\Scripts\\python.exe ..\\validation\\local-delivery\\serve.py',
      url: 'http://127.0.0.1:8000/api/v1/health',
      reuseExistingServer: false, timeout: 30_000,
    },
    {
      command: 'npm run start:local', url: 'http://127.0.0.1:5173',
      reuseExistingServer: false, timeout: 30_000,
    },
  ],
})
