import { expect, test } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeCardId, smokeOperatorCard } from './fixtures/operator-rest-fixtures.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const syntheticToken = 'synthetic-playwright-token';

test('desktop card detail keeps all content reachable inside the bounded detail scroller', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required');
  const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1280, height: 720 });
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await page.route(`**/api/cards/${smokeCardId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
       body: JSON.stringify(parseOperatorResponse('cards.get', 200, {
          card: smokeOperatorCard,
       })),
    });
  });

  await seedTokenBeforeNavigation(page, syntheticToken);
  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto(`/cards/${smokeCardId}`)));

  await expect(page.getByText('Synthetic dashboard smoke card').first()).toBeVisible();
  await page.getByText('Metadata', { exact: true }).click();

  const container = page.locator('.card-detail-container');
  await expect(container).toHaveJSProperty('isConnected', true);
  await expect.poll(async () => container.evaluate((el, viewportHeight) => el.getBoundingClientRect().height <= viewportHeight, 720)).toBe(true);
  await expect.poll(async () => container.evaluate((el) => {
    const overflowY = getComputedStyle(el).overflowY;
    return el.scrollHeight > el.clientHeight && (overflowY === 'auto' || overflowY === 'scroll');
  })).toBe(true);
  await container.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(async () => container.evaluate((el) => {
    const summaries = Array.from(el.querySelectorAll('summary'));
    const marker = summaries.find((summary) => (summary.textContent ?? '').includes('Version history'));
    if (!marker) return null;
    const box = el.getBoundingClientRect();
    const markerBox = marker.getBoundingClientRect();
    const tolerance = 1;
    return markerBox.bottom <= box.bottom + tolerance && markerBox.top >= box.top - tolerance;
  })).toBe(true);
  await page.getByText('Version history', { exact: true }).click();
  const versionTwo = page.locator('.history-item').filter({ hasText: 'v2' });
  await expect(versionTwo).toContainText('status -> running');
  await expect(versionTwo.locator('.history-change-fields')).toHaveText('lifecycle');
  await expect(page.getByText('Diff vs current card', { exact: true })).toBeVisible();
  await expect(page.getByText('Snapshot body', { exact: true })).toBeVisible();
  await expect(page.locator('.diff-field')).toHaveText(['lifecycle', 'status_text', 'status_text_updated_at']);
  expect(rest.counts.get(`GET /api/cards/${smokeCardId}/history`)).toBe(1);
  expect(rest.counts.get(`GET /api/cards/${smokeCardId}/history/2`)).toBe(1);
  expect(rest.counts.get(`GET /api/cards/${smokeCardId}/diff`)).toBe(1);

  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(pageErrors).toEqual([]);
});
