import { expect, test } from '@playwright/test';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const syntheticToken = 'synthetic-playwright-token';
const sessionId = 'analyst:global';
const now = '2026-05-19T12:00:00.000Z';
const roundId = 'r-assistant-00000000000000000000000000000001';

const entries = Array.from({ length: 60 }, (_, index) => ({
  id: `chat-overflow-${index}`,
  session_id: sessionId,
  role: 'assistant' as const,
  kind: 'text' as const,
  content: [
    `Overflow regression entry ${index + 1}.`,
    'This synthetic analyst message intentionally spans multiple lines.',
    'It gives the real browser enough transcript content to require the inner panel scroller.',
  ].join('\n'),
  round_id: roundId,
  message_index: index,
  block_index: 0,
  timestamp: now,
}));

test('desktop analyst panel keeps the transcript scroll inside the bounded pane', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await page.setViewportSize({ width: 1280, height: 720 });
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await page.route('**/api/chats/analyst%3Aglobal', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(parseOperatorResponse('chats.get', { sessionId, entries })),
    });
  });

  await page.addInitScript((token) => window.localStorage.setItem('saivage_api_token', token), syntheticToken);
  await page.goto('/dashboard');

  await expect(page.getByRole('region', { name: 'Analyst chat' })).toBeVisible();
  await page.evaluate((id) => window.__saivageWsFixture?.emit({ t: 'invalidate', resource: 'conversation', id }), sessionId);

  await expect(page.locator('.analyst-pane')).toHaveJSProperty('isConnected', true);
  await expect.poll(async () => page.locator('.analyst-pane').evaluate((el, viewportHeight) => el.getBoundingClientRect().height <= viewportHeight, 720)).toBe(true);
  await expect.poll(async () => page.locator('.analyst-pane .chat-scroll-area').evaluate((el) => {
    const overflowY = getComputedStyle(el).overflowY;
    return el.scrollHeight > el.clientHeight && (overflowY === 'auto' || overflowY === 'scroll');
  })).toBe(true);

  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
