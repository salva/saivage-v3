import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const pagesDist = process.env.SAIVAGE_BRAND_PAGES_DIST ?? resolve(import.meta.dirname, '../../../tmp/playwright-builds/branding-pages');

export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 10_000 }, reporter: 'list',
  outputDir: '../../../tmp/playwright-results/branding',
  use: { baseURL: 'http://127.0.0.1:4189', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'exec timeout --foreground -k 15s 600s sh -c \'cd ../../.. && DOCS_BASE=/saivage-v3/ npm exec -- vitepress build docs --outDir "$SAIVAGE_BRAND_PAGES_DIST" && exec node --import tsx tests/playwright/branding/server.ts\'',
    env: { SAIVAGE_BRAND_PAGES_DIST: pagesDist },
    url: 'http://127.0.0.1:4189/docs/', reuseExistingServer: false, timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  } } }],
});
