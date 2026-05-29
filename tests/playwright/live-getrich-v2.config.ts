import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.SAIVAGE_LIVE_BASE_URL ?? 'http://10.0.3.170:8080';

export default defineConfig({
  testDir: '.',
  testMatch: /live-getrich-v2(-extra|-ui)?\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: '../../tmp/playwright-live-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
