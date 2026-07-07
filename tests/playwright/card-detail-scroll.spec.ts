import { expect, test } from '@playwright/test';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const syntheticToken = 'synthetic-playwright-token';
const now = '2026-05-19T12:00:00.000Z';

const card = {
  id: 'card-smoke',
  type: 'code',
  parent: 'project-smoke',
  depth: 1,
  position: 1,
  title: 'Synthetic dashboard smoke card',
  status: 'done',
  lifecycle: { status: 'done', result: { kind: 'done', summary: 'synthetic result' }, error: null, completed_at: now },
  display_path: '1',
  operator_summary: { lifecycleStatus: 'done', terminal: true, needsVerification: false, blocked: false, hasError: false, error: null, completedAt: now, stale: false, actionCount: 0 },
  tags: ['smoke'],
  priority: 90,
  urgency: 'normal',
  created_by: 'user',
  created_at: now,
  updated_at: now,
  depends_on: [],
  related: [],
  retries: 0,
  version_seq: 3,
} as const;

const baseChild = {
  type: 'code',
  parent: 'card-smoke',
  depth: 2,
  status: 'done',
  lifecycle: {
    status: 'done',
    result: { kind: 'done', summary: 'Synthetic child done result.' },
    error: null,
    completed_at: now,
  },
  tags: [],
  priority: 50,
  urgency: 'normal',
  created_by: 'planner',
  created_at: now,
  updated_at: now,
  depends_on: [],
  related: [],
  retries: 0,
  version_seq: 1,
  operator_summary: { lifecycleStatus: 'done', terminal: true, needsVerification: false, blocked: false, hasError: false, error: null, completedAt: now, stale: false, actionCount: 0 },
} as const;

const children = Array.from({ length: 40 }, (_, index) => ({
  ...baseChild,
  id: `card-smoke-child-${index + 1}`,
  position: index + 1,
  title: `Synthetic child card ${index + 1} for hierarchy overflow`,
  display_path: `1.${index + 1}`,
}));

test('desktop card detail keeps all content reachable inside the bounded detail scroller', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await page.setViewportSize({ width: 1280, height: 720 });
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await page.route('**/api/cards/card-smoke', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(parseOperatorResponse('cards.get', {
        card: { ...card, dependencyRefs: [], relatedRefs: [] },
        children,
        ancestorIds: ['project-smoke'],
        ancestorRefs: [{ id: 'project-smoke', display_path: null, title: 'Synthetic Project' }],
      })),
    });
  });

  await page.goto('/cards/card-smoke');
  await page.evaluate((token) => window.localStorage.setItem('saivage_api_token', token), syntheticToken);
  await page.reload();

  await expect(page.getByText('Synthetic dashboard smoke card').first()).toBeVisible();

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

  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
