import { expect, test } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

const invalidSyntheticToken = 'synthetic-invalid-playwright-token';
const savedSyntheticToken = 'synthetic-cycle-037-token';

test('operator control room shows no-token state without leaking secrets when no token is configured', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required'); const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installOperatorWebSocketShim(page);

  const rest = await installOperatorRestRoutes(page);

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/dashboard')));

  await expect(page.locator('.workspace-header .ws-connected')).toBeVisible();
  await page.getByRole('button', { name: 'Manage API token for API and WebSocket access' }).click();
  await expect(page.getByText('No token configured.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('synthetic-invalid-playwright-token')).toHaveCount(0);
  await expect(page.getByTestId('api-auth-banner')).toHaveCount(0);

  expect(rest.authorizations).toEqual([]);
  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(pageErrors).toEqual([]);
});

test('operator control room reconnects WebSocket and REST authorization when token is saved and cleared', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required'); const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/dashboard')));
  await expect(page.locator('.workspace-header .ws-connected')).toBeVisible();
  expect(rest.authorizations).toEqual([]);

  await page.getByRole('button', { name: 'Manage API token for API and WebSocket access' }).click();
  await page.getByRole('textbox', { name: 'Token' }).fill(savedSyntheticToken);
  await failures.during('auth-reconfiguration', () => waitForRuntimePair(page, () => page.getByRole('button', { name: 'Save' }).click()));

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

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.reload()));
  await expect(page.locator('.workspace-header .ws-connected')).toBeVisible();
  await expect(page.getByText(savedSyntheticToken)).toHaveCount(0);
  await expect.poll(() => rest.authorizations.filter((header) => header === `Bearer ${savedSyntheticToken}`).length).toBeGreaterThan(2);

  await page.getByRole('button', { name: 'Manage API token for API and WebSocket access' }).click();
  await expect(page.getByText('Token is set.')).toBeVisible();
  await expect(page.getByText(savedSyntheticToken)).toHaveCount(0);
  const authorizationCountBeforeClear = rest.authorizations.length;

  await failures.during('auth-reconfiguration', () => waitForRuntimePair(page, () => page.getByRole('button', { name: 'Clear' }).click()));
  await expect(page.getByText('No token configured.').first()).toBeVisible();
  await expect(page.locator('.workspace-header .ws-connected')).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem('saivage_api_token'))).toBeNull();
  await expect(page.getByText(savedSyntheticToken)).toHaveCount(0);
  expect(rest.authorizations.slice(authorizationCountBeforeClear)).toEqual([]);

  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation', 'auth-reconfiguration']);
  expect(pageErrors).toEqual([]);
});

test('operator control room surfaces API auth-required banner on synthetic 401 without exposing invalid token', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required'); const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await seedTokenBeforeNavigation(page, invalidSyntheticToken); await installOperatorWebSocketShim(page);

  const rest = await installOperatorRestRoutes(page, { unauthorized: true });

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/dashboard')));

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
  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.reload()));
  await expect(page.getByTestId('api-auth-banner')).toHaveCount(0);
  await expect(page.getByText(invalidSyntheticToken)).toHaveCount(0);

  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(pageErrors).toEqual([]);
});
