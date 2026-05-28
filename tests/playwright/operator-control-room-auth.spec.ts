import { expect, test } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';

const invalidSyntheticToken = 'synthetic-invalid-playwright-token';

test('operator control room shows no-token state without leaking secrets when no token is configured', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  const rest = await installOperatorRestRoutes(page);

  await page.goto('/dashboard');

  await expect(page.getByText('NO TOKEN')).toBeVisible();
  await page.getByRole('button', { name: 'Manage API token for API and WebSocket access' }).click();
  await expect(page.getByText('No token configured.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('synthetic-invalid-playwright-token')).toHaveCount(0);
  await expect(page.getByTestId('api-auth-banner')).toHaveCount(0);

  expect(rest.authorizations).toEqual([]);
  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('operator control room surfaces API auth-required banner on synthetic 401 without exposing invalid token', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  const rest = await installOperatorRestRoutes(page, { unauthorized: true });

  await page.goto('/dashboard');
  await page.evaluate((token) => window.localStorage.setItem('saivage_api_token', token), invalidSyntheticToken);
  await page.reload();

  const banner = page.getByTestId('api-auth-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('API token required');
  await expect(banner).toContainText('Set a valid API token to load secured runtime data.');
  const unauthorizedCue = page.locator('.cue-chip.cue-unauthorized');
  await expect(unauthorizedCue).toBeVisible();
  await expect(unauthorizedCue).toContainText('Unauthorized');
  await expect(unauthorizedCue).toHaveAttribute('title', 'API and WebSocket access were rejected. Re-enter a valid token.');
  await expect(page.getByText(invalidSyntheticToken)).toHaveCount(0);
  await expect.poll(() => rest.authorizations.length).toBeGreaterThan(0);
  expect(rest.authorizations.every((header) => header === `Bearer ${invalidSyntheticToken}`)).toBe(true);

  await page.getByRole('button', { name: 'Dismiss API token banner' }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('api-auth-banner')).toHaveCount(0);
  await expect(page.getByText(invalidSyntheticToken)).toHaveCount(0);

  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
