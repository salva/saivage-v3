import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SAIVAGE_CHAT_API_CLIENT_BROWSER_PORT ?? 4187);

export default defineConfig({
  testDir: '.',
  testMatch: /(^|\/)chat-api-client-browser\.spec\.ts$/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../../../tmp/playwright-report/browser-client' }]] : 'list',
  outputDir: '../../../tmp/playwright-results/browser-client',
  use: {
    baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure',
  },
  webServer: {
    command: `cd ../../../web && npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        },
      },
    },
  ],
});
