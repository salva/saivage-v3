import { expect, test } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const syntheticToken = 'synthetic-playwright-token';
const sessionId = 'agent:analyst:global';
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
  context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true } as const,
  round_id: roundId,
  message_index: index,
  block_index: 0,
  timestamp: now,
}));

test('desktop analyst panel keeps the transcript scroll inside the bounded pane', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required');
  const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1280, height: 720 });
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  const conversation = parseOperatorResponse('agents.conversation', 200, {
    session_id: sessionId,
    segment_version: 1,
    segment_context: null,
    entries,
    cursor: { segment_version: 1, message_id: entries.at(-1)!.id },
  });
  await page.route(`**/api/agents/${encodeURIComponent(sessionId)}/conversation*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    });
  });

  await seedTokenBeforeNavigation(page, syntheticToken);
  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/dashboard')));

  await expect(page.getByRole('region', { name: 'Analyst chat' })).toBeVisible();
  await expect(page.getByText('Overflow regression entry 1.')).toBeVisible();
  await expect(page.getByText('Overflow regression entry 60.')).toBeVisible();

  await expect(page.locator('.analyst-pane')).toHaveJSProperty('isConnected', true);
  await expect.poll(async () => page.locator('.analyst-pane').evaluate((el, viewportHeight) => el.getBoundingClientRect().height <= viewportHeight, 720)).toBe(true);
  await expect.poll(async () => page.locator('.analyst-pane .chat-scroll-area').evaluate((el) => {
    const overflowY = getComputedStyle(el).overflowY;
    return el.scrollHeight > el.clientHeight && (overflowY === 'auto' || overflowY === 'scroll');
  })).toBe(true);

  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(pageErrors).toEqual([]);
});
