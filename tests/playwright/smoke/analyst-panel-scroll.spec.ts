import { expect, test } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { toolRowPolicies } from '../../helpers/row-policy-fixtures.js';
import { validateProcessToolResult } from '../../../src/tools/process-tool-result.js';

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
    segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1,
    segment_context: null,
    entries,
    cursor: { segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, message_id: entries.at(-1)!.id },
  });
  await page.route(`**/api/agents/${encodeURIComponent(sessionId)}/conversation*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    });
  });

  await seedTokenBeforeNavigation(page, syntheticToken);
  await waitForRuntimePair(page, () => page.goto('/dashboard'));

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
  assertPreviewRequestFailures(failures);
  expect(pageErrors).toEqual([]);
});

for (const paused of [false, true]) {
  test(`Analyst accepted mate frame preserves reading position and expansion, Pause=${paused}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedTokenBeforeNavigation(page, syntheticToken);
    await installOperatorWebSocketShim(page);
    const rest = await installOperatorRestRoutes(page);
    const segment = '11111111-1111-4111-8111-111111111111';
    const stdout = 'Complete retained head FINAL-Z';
    const content = JSON.stringify({ success: true, data: validateProcessToolResult({ status: 'exited', exit_code: 0, process_id: 'proc-012345abcdef', stdout, stderr: '', stdout_complete: true, stderr_complete: true, stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: 0, stdout_url: 'work:///processes/proc-012345abcdef/stdout.log', stderr_url: 'work:///processes/proc-012345abcdef/stderr.log' }) });
    const policy = toolRowPolicies({ content });
    const base = { session_id: sessionId, tool: 'run_command', tool_call_id: 'arrival-call', round_id: roundId, message_index: 0, block_index: 0, timestamp: now };
    const call = { ...base, id: `${segment}:tool-call:arrival-call`, role: 'assistant', kind: 'tool_call', context_policy: policy.call,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'arrival-call', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: `${'long full command\n'.repeat(80)}FINAL-COMMAND-Z` }) } }] }) };
    const result = { ...base, id: `${segment}:tool-result:arrival-call`, role: 'tool', kind: 'tool_result', context_policy: policy.result, content };
    let mode = 0, reads = 0;
    await page.route('**/api/agents/*/conversation**', async route => {
      if (decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!) !== sessionId) return route.fallback();
      reads++;
      const selected = new URL(route.request().url()).searchParams.has('since')
        ? mode === 1 ? [result] : [{ ...entries[0]!, id: `new-arrival-${mode}` }]
        : [call, ...entries];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversation', 200, { session_id: sessionId, segment_id: segment, segment_version: 1, segment_context: null, entries: selected, cursor: { segment_id: segment, segment_version: 1, message_id: selected.at(-1)!.id } })) });
    });
    await page.goto('/dashboard');
    const pane = page.getByRole('region', { name: 'Analyst chat' }), owner = pane.getByTestId('chat-scroll-container');
    const tool = pane.locator('.tool-chip');
    await expect(tool).toHaveCount(1);
    await expect.poll(() => owner.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(65);
    await tool.locator('.tool-chip-toggle').click();
    await expect(tool).toContainText('FINAL-COMMAND-Z');
    const visible = pane.locator('[data-entry-id="chat-overflow-20"]');
    await visible.scrollIntoViewIfNeeded();
    await owner.evaluate(el => el.dispatchEvent(new Event('scroll')));
    if (paused) await pane.getByLabel('Pause auto-scroll').check();
    const location = await visible.evaluate(el => el.getBoundingClientRect().top);
    const prior = reads;
    mode = 1;
    await page.evaluate(({ id, segment }) => window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_id: segment, segment_version: 1, visible_message_id: `${segment}:tool-result:arrival-call` }), { id: sessionId, segment });
    await expect.poll(() => reads).toBeGreaterThan(prior);
    await expect(tool).toContainText('Exited · exit 0');
    await expect(tool.locator('.tool-chip-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(tool).toHaveCount(1);
    await expect(pane.getByRole('button', { name: /Jump to latest/ })).toContainText('1 new');
    expect(Math.abs(await visible.evaluate(el => el.getBoundingClientRect().top) - location)).toBeLessThan(3);
    await expect(pane.getByLabel('Pause auto-scroll')).toBeChecked({ checked: paused });
    await pane.getByRole('button', { name: /Jump to latest/ }).click();
    await expect(pane.getByLabel('Pause auto-scroll')).toBeChecked({ checked: paused });
    const top = await owner.evaluate(el => el.scrollTop);
    mode = 2;
    await page.evaluate(({ id, segment }) => window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_id: segment, segment_version: 1, visible_message_id: 'new-arrival-2' }), { id: sessionId, segment });
    await expect(pane.locator('[data-entry-id="new-arrival-2"]')).toHaveCount(1);
    if (paused) { expect(await owner.evaluate(el => el.scrollTop)).toBe(top); await pane.getByLabel('Pause auto-scroll').uncheck(); }
    await expect.poll(() => owner.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(65);
    await pane.getByLabel('Analyst chat composer').fill('Still usable');
    await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    expect(rest.unknown).toEqual([]);
  });
}
