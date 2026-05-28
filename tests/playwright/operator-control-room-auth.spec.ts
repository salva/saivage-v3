import { expect, test } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const invalidSyntheticToken = 'synthetic-invalid-playwright-token';
const savedSyntheticToken = 'synthetic-cycle-037-token';

test('operator control room shows no-token state without leaking secrets when no token is configured', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  const rest = await installOperatorRestRoutes(page);

  await page.goto('/dashboard');

  await expect(page.locator('.workspace-header .ws-no-token')).toContainText('NO TOKEN');
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

test('operator control room reconnects WebSocket and REST authorization when token is saved and cleared', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  await page.goto('/dashboard');
  await expect(page.locator('.workspace-header .ws-no-token')).toContainText('NO TOKEN');
  expect(rest.authorizations).toEqual([]);

  await page.getByRole('button', { name: 'Manage API token for API and WebSocket access' }).click();
  await page.getByRole('textbox', { name: 'Token' }).fill(savedSyntheticToken);
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('heading', { name: 'API Token' })).toHaveCount(0);
  await expect(page.locator('.workspace-header .ws-connected')).toBeVisible();
  await expect.poll(() => rest.authorizations.filter((header) => header === `Bearer ${savedSyntheticToken}`).length).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.localStorage.getItem('saivage_api_token'))).toBe(savedSyntheticToken);
  await expect(page.getByText(savedSyntheticToken)).toHaveCount(0);

  const socketUrls = await page.evaluate(() => window.__saivageWsFixture?.sockets.map((socket) => String((socket as { url?: string }).url)) ?? []);
  expect(socketUrls.length).toBeGreaterThan(0);
  const lastSocketUrl = new URL(socketUrls.at(-1)!);
  expect(lastSocketUrl.pathname).toBe('/ws');
  expect(lastSocketUrl.searchParams.get('ticket')).toBe('synthetic-ws-ticket');
  expect(lastSocketUrl.searchParams.has('token')).toBe(false);

  await page.reload();
  await expect(page.locator('.workspace-header .ws-connected')).toBeVisible();
  await expect(page.getByText(savedSyntheticToken)).toHaveCount(0);
  await expect.poll(() => rest.authorizations.filter((header) => header === `Bearer ${savedSyntheticToken}`).length).toBeGreaterThan(2);

  await page.getByRole('button', { name: 'Manage API token for API and WebSocket access' }).click();
  await expect(page.getByText('Token is set.')).toBeVisible();
  await expect(page.getByText(savedSyntheticToken)).toHaveCount(0);
  const authorizationCountBeforeClear = rest.authorizations.length;

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('No token configured.').first()).toBeVisible();
  await expect(page.locator('.workspace-header .ws-no-token')).toContainText('NO TOKEN');
  expect(await page.evaluate(() => window.localStorage.getItem('saivage_api_token'))).toBeNull();
  await expect(page.getByText(savedSyntheticToken)).toHaveCount(0);
  expect(rest.authorizations.slice(authorizationCountBeforeClear)).toEqual([]);

  await page.getByRole('button', { name: 'Cancel' }).click();
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
