import { expect, test } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const syntheticToken = 'synthetic-playwright-token';

test('operator control room smoke walks browser routes with REST fixtures and WebSocket shim', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  await page.goto('/dashboard');
  await page.evaluate((token) => window.localStorage.setItem('saivage_api_token', token), syntheticToken);
  await page.reload();

  await expect(page.getByText('Dashboard').first()).toBeVisible();
  await expect(page.getByText('saivage-v3')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Runtime Console' })).toBeVisible();
  await expect(page.getByText('Root Run')).toBeVisible();
  await expect(page.getByText('planner-smok...')).toBeVisible();
  await expect(page.getByText('Total Cards')).toBeVisible();
  await expect(page.getByText(syntheticToken)).toHaveCount(0);

  await expect.poll(async () => page.evaluate(() => window.__saivageWsFixture?.sockets.length ?? 0)).toBeGreaterThan(0);
  await expect(page.getByText(/Live updates connected/i).first()).toBeVisible();

  await expect(page.locator('.pause-chip')).toHaveCount(0);

  await page.getByText('Cards').first().click();
  await expect(page).toHaveURL(/\/cards$/);
  await expect(page.getByText('Synthetic dashboard smoke card').first()).toBeVisible();
  await page.goto('/cards/card-smoke');
  await expect(page.getByText('Card Detail').first()).toBeVisible();
  await expect(page.getByText('Priority').first()).toBeVisible();
  await expect(page.getByText('synthetic result').first()).toBeVisible();

  await page.getByText('Agents').first().click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByText('analyst').first()).toBeVisible();
  await expect(page.getByText('planner').first()).toBeVisible();
  await page.locator('.session-card').first().click();
  await expect(page.locator('.detail-header-bar')).toContainText('analyst-smoke');
  await expect(page.getByText('Synthetic agent transcript.').first()).toBeVisible();

  await page.getByText('Files').first().click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByText('plan.json')).toBeVisible();
  await page.getByText('plan.json').click();
  await expect(page.getByText('operator-playwright-smoke')).toBeVisible();

  await page.getByText('Debug').first().click();
  await expect(page).toHaveURL(/\/debug$/);
  await expect(page.getByText('Timeline').first()).toBeVisible();
  await page.getByText('Errors').first().click();
  await expect(page.getByText('Synthetic provider failure redacted')).toBeVisible();

  await page.goto('/dashboard');
  await page.evaluate(() => window.__saivageWsFixture?.emitRuntimeUpdate());
  await expect(page.getByRole('region', { name: 'Runtime Console' }).getByText(/Total Cards\s*3/)).toBeVisible();

  await page.goto('/route-that-does-not-exist');
  await expect(page.getByRole('heading', { name: /404 — Not found/i })).toBeVisible();
  await expect(page.getByText('/route-that-does-not-exist')).toBeVisible();

  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
