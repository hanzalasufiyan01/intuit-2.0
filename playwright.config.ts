import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end smoke tests (FP-20). They run against a real API and web dev server, which
 * Playwright starts (or reuses when already running). The API needs the repository `.env` and a
 * migrated development database (`pnpm db:setup`); each test registers its own user and
 * organization, so no seed data is required. Run: `pnpm e2e` (first time: `pnpm e2e:install`).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm dev:api',
      url: 'http://127.0.0.1:3000/api/v1/health',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev:web',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
