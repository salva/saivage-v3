import { expect, test } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeCardId, smokeOperatorCard } from './fixtures/operator-rest-fixtures.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const syntheticToken = 'synthetic-playwright-token';

test('desktop card records facet keeps all content reachable inside the bounded cockpit scroller', async ({ page, baseURL }) => {
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
  const longBrief = Array.from({ length: 40 }, (_, index) => `Synthetic brief paragraph ${index + 1} with enough prose to require the bounded records scroller to scroll for the version history below.`).join('\n\n');
  await page.route(`**/api/cards/${smokeCardId}/records/**`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? 'brief.md');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(parseOperatorResponse('cards.records.get', 200, {
        card_id: smokeCardId,
        record: {
          name,
          head_version: 1,
          head_entry_id: '11111111-1111-4111-8111-111111111111',
          state: 'closed',
          accepted: {
            source_version: 1,
            source_entry_id: '11111111-1111-4111-8111-111111111111',
            committed_at: '2026-05-19T12:00:00.000Z',
            writer_agent: 'runtime:bootstrap',
            card_version_seq: 1,
            content: longBrief,
            content_sha256: 'a'.repeat(64),
            size_bytes: longBrief.length,
          },
          draft: null,
          discarded: null,
          effective_content_source: 'accepted',
        },
      })),
    });
  });

  await seedTokenBeforeNavigation(page, syntheticToken);
  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto(`/cards/${smokeCardId}?facet=records`)));

  await expect(page.getByText('Synthetic dashboard smoke card').first()).toBeVisible();

  const container = page.locator('.records-facet');
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
    const marker = summaries.find((summary) => (summary.textContent ?? '').includes('Card versions'));
    if (!marker) return null;
    marker.scrollIntoView({ block: 'nearest' });
    const box = el.getBoundingClientRect();
    const markerBox = marker.getBoundingClientRect();
    const tolerance = 1;
    return markerBox.bottom <= box.bottom + tolerance && markerBox.top >= box.top - tolerance;
  })).toBe(true);
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
