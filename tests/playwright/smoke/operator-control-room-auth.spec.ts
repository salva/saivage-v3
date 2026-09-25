import { expect, test } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

const syntheticToken = 'synthetic-playwright-token';
const invalidSyntheticToken = 'synthetic-invalid-playwright-token';

test('operator control room stays connected without leaking secrets and exposes no authentication UI', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required'); const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installOperatorWebSocketShim(page);

  const rest = await installOperatorRestRoutes(page);

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/')));

  await expect(page.getByTestId('strip-socket')).toHaveText('Connected');
  await expect(page.getByRole('button', { name: /API token|Token/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'API Token' })).toHaveCount(0);
  await expect(page.getByTestId('api-auth-banner')).toHaveCount(0);
  await expect(page.getByText(/Open Token|Re-enter a valid|Provide a valid API token/i)).toHaveCount(0);
  await expect(page.getByText(syntheticToken)).toHaveCount(0);

  expect(rest.authorizations).toEqual([]);
  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(pageErrors).toEqual([]);
});

test('operator control room presents honest unauthorized observation on synthetic 401 without exposing the invalid token', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required'); const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await seedTokenBeforeNavigation(page, invalidSyntheticToken); await installOperatorWebSocketShim(page);

  const rest = await installOperatorRestRoutes(page, {
    unauthorized: (method, pathname) => method === 'GET' && (pathname === '/api/state' || pathname === '/api/runtime/status'),
  });

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/')));

  const restChip = page.getByTestId('strip-rest');
  await expect(restChip).toHaveText('REST Unauthorized');
  await expect(restChip).toHaveClass(/rest-unauthorized/);
  await expect(page.getByText('Runtime observation unauthorized', { exact: true })).toBeVisible();
  await expect(page.getByTestId('api-auth-banner')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /API token|Token/i })).toHaveCount(0);
  await expect(page.getByText(/Open Token|Re-enter a valid|Provide a valid API token|Set a valid API token/i)).toHaveCount(0);
  await expect(page.getByText(invalidSyntheticToken)).toHaveCount(0);
  await expect.poll(() => rest.authorizations.length).toBeGreaterThan(0);
  expect(rest.authorizations.every((header) => header === `Bearer ${invalidSyntheticToken}`)).toBe(true);

  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(pageErrors).toEqual([]);
});
