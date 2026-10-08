import { expect, test, type Locator } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { RecordMutationSuccessSchema } from '../../../src/contracts/record-mutation.js';
import { validateProcessToolResult } from '../../../src/tools/process-tool-result.js';
import { toolRowPolicies } from '../../helpers/row-policy-fixtures.js';
import { installOperatorRestRoutes, smokeCardId } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';

const executor = `agent:executor:${smokeCardId}`;
const analyst = 'agent:analyst:global';
const segment = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-10-07T12:00:00.000Z';
const processId = 'proc-012345abcdef';
const command = `printf '%s\\n' ${'long_unbroken_argument_'.repeat(12)} --final-character-Z`;
const stdout = `${Array.from({ length: 4 }, () => 'Recorded stdout head '.repeat(20)).join('\n')}\nlast stdout character Z`;
const stderr = 'Recorded failure: assertion mismatch\nlast stderr character Q';
const recordUrl = `record:///status.md?card=${smokeCardId}`;
const rowId = (id: string, result = false) => `${segment}:tool-${result ? 'result' : 'call'}:${id}`;
function text(session: string, id: string, content: string) {
  return { id, session_id: session, role: 'assistant', kind: 'text', content,
    context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
    round_id: `r-assistant-${segment.replaceAll('-', '')}`, message_index: 0, block_index: 0, timestamp };
}
function pair(session: string, id: string, tool: string, args: object, result: object) {
  const content = JSON.stringify(result), policy = toolRowPolicies({ content });
  const base = { session_id: session, tool, tool_call_id: id, message_index: 0, block_index: 0, timestamp, round_id: `r-assistant-${segment.replaceAll('-', '')}` };
  return [
    { ...base, id: rowId(id), role: 'assistant', kind: 'tool_call', context_policy: policy.call,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }) },
    { ...base, id: rowId(id, true), role: 'tool', kind: 'tool_result', context_policy: policy.result, content },
  ];
}
function rows(session: string) {
  const output = validateProcessToolResult({ process_id: processId, status: 'exited', exit_code: 0, stdout, stderr, stdout_bytes: Buffer.byteLength(stdout) + 1000, stderr_bytes: Buffer.byteLength(stderr), stdout_complete: false, stderr_complete: true,
    stdout_url: `work:///processes/${processId}/stdout.log`, stderr_url: `work:///processes/${processId}/stderr.log` });
  const run = pair(session, 'run', 'run_command', { command, wait: false }, { success: true, data: output });
  const draft = RecordMutationSuccessSchema.parse({ kind: 'applied', data: { card_id: smokeCardId, name: 'status.md', state: 'open', surface: 'card_agent', revision: 7,
    head_id: '33333333-3333-4333-8333-333333333333', current_url: recordUrl, accepted_version_url: `${recordUrl}&v=4`, bytes: 14, written: true } }).data;
  const accepted = RecordMutationSuccessSchema.parse({ kind: 'applied', data: { ...draft, state: 'closed', surface: 'analyst', revision: 8, head_id: '44444444-4444-4444-8444-444444444444', accepted_version_url: `${recordUrl}&v=8`, bytes: 17, propagation: { ok: false, partial: true, error: 'Ancestor notification refused' } } }).data;
  return [run[0]!, text(session, 'intervening-prose', 'Correction before the process observation.'), run[1]!,
    ...pair(session, 'wait', 'wait_process', { process_id: processId, timeout_ms: 0 }, { success: true, data: { ...output, exit_code: 1 } }),
    ...pair(session, 'edit', 'edit', { path: 'src/example.ts', old_string: 'old supplied text', new_string: 'new supplied text', replace_all: true }, { success: true, data: { path: 'src/example.ts', replacements: 2, bytes: 38, edited: true } }),
    ...pair(session, 'draft', 'write', { path: recordUrl, content: 'Draft content.' }, { success: true, data: draft }),
    ...pair(session, 'accept', 'write', { path: recordUrl, content: 'Accepted content.' }, { success: true, data: accepted }),
    ...pair(session, 'notice', 'queue_notification', { card_id: smokeCardId, kind: 'context', urgency: 'urgent', body: 'Full notice.' }, { success: true, data: { queued: true, card_id: smokeCardId, notification_id: '55555555-5555-4555-8555-555555555555', body: 'Full notice.', interruption: { status: 'pending_tool_settlement' } } }),
    ...pair(session, 'restart', 'restart_server', {}, { success: true, data: { restart: 'confirmation_required', confirmationMessage: 'RESTART SERVER' } }),
    ...pair(session, 'uncertain', 'edit', { path: 'src/uncertain.ts', old_string: 'before', new_string: 'after' }, { success: false, data: { outcome_unknown: true }, error: 'Prior effects may or may not have occurred.' }),
    ...pair(session, 'missing', 'read', { path: 'missing.txt' }, { success: false, error: 'File not found: missing.txt' }),
    pair(session, 'unmatched', 'wait_process', { process_id: processId }, { success: true })[0]!,
    pair(session, 'retained-result', 'wait_process', {}, { success: true, data: output })[1]!,
    ...pair(session, 'image', 'view_image', { path: 'screen.png', max_dimension: 1600 }, { success: true, image: { id: segment, mime_type: 'image/png', width: 1600, height: 800, byte_length: 1000, sha256: 'a'.repeat(64) }, data: { source_path: 'screen.png', source_dimensions: { width: 2048, height: 1024 }, oriented_dimensions: { width: 2048, height: 1024 }, sent_dimensions: { width: 1600, height: 800 }, orientation_applied: false, resized: true, scale: { x: 0.78125, y: 0.78125 }, max_dimension: 1600 } }),
    ...Array.from({ length: 24 }, (_, i) => text(session, `tail-${i}`, `Retained tail row ${i}: ${'observational context '.repeat(12)}`)),
  ];
}
function chip(reader: Locator, id: string) { return reader.locator(`[data-tool-entry-id="${rowId(id)}"]`); }
async function expand(row: Locator) { await row.locator('.tool-chip-toggle').click(); await expect(row.locator('.tool-chip-toggle')).toHaveAttribute('aria-expanded', 'true'); }

for (const viewport of [{ width: 1440, height: 900 }, { width: 1296, height: 899 }, { width: 900, height: 700 }, { width: 390, height: 844 }]) {
  test(`combined safe semantic inspection and exact-half navigation ${viewport.width}`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await seedTokenBeforeNavigation(page, 'synthetic-semantic-token');
    await installOperatorWebSocketShim(page);
    const rest = await installOperatorRestRoutes(page);
    await page.route('**/api/agents/*/conversation**', async route => {
      const url = new URL(route.request().url()), session = decodeURIComponent(url.pathname.split('/')[3]!);
      if (![executor, analyst].includes(session) || url.pathname.endsWith('/versions')) return route.fallback();
      const entries = rows(session), history = url.pathname.endsWith('/versions/1');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(history
        ? parseOperatorResponse('agents.conversationVersions.get', 200, { session_id: session, version: 1, entry_id: segment, published_at: timestamp, segment_context: null, entries })
        : parseOperatorResponse('agents.conversation', 200, { session_id: session, segment_id: segment, segment_version: 1, segment_context: null, entries, cursor: { segment_id: segment, segment_version: 1, message_id: entries.at(-1)!.id } })) });
    });
    await page.goto(`/agents/${executor}?segment=1`);
    const reader = page.locator('.conversation-reading-surface');
    await expect(reader.locator('.tool-chip')).toHaveCount(12);
    for (const [id, meaning] of [['run', 'Exited · exit 0'], ['wait', 'Process failed · exit 1'], ['draft', 'Draft updated'], ['accept', 'Partial propagation'], ['notice', 'Delivery not reported'], ['restart', 'Confirmation required'], ['uncertain', 'Effects uncertain'], ['missing', 'File not found'], ['unmatched', 'No result recorded'], ['image', 'Image snapshot recorded']] as const) await expect(chip(reader, id)).toContainText(meaning);
    await expect(chip(reader, 'run')).toContainText('Result recorded later');
    await expect(chip(reader, 'run').locator('.tool-chip-status')).not.toContainText('stdout');
    await expand(chip(reader, 'run'));
    const run = chip(reader, 'run');
    await expect(run.locator('[data-entry-id]')).toHaveCount(2);
    await expect(run.getByText(command, { exact: true })).toBeVisible();
    await expect(run).toContainText('1 retained entries between request and result');
    for (const half of ['request', 'result'] as const) {
      const raw = run.locator(`.tool-${half} .safe-original`);
      await raw.locator('summary').click();
      await raw.getByRole('button', { name: 'copy', exact: true }).click();
      const expected = rows(executor).find(entry => entry.id === rowId('run', half === 'result'))!.content;
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
    }
    await run.getByText('Show stdout', { exact: true }).click();
    await expect(run).toContainText('last stdout character Z');
    await expect(run.getByRole('link', { name: 'stdout Files', exact: true })).toHaveAttribute('href', /stdout.log/);
    await expand(chip(reader, 'edit')); await expect(chip(reader, 'edit')).toContainText('new supplied text');
    await expand(chip(reader, 'draft')); await expect(chip(reader, 'draft')).toContainText('Retained accepted version');
    await expand(chip(reader, 'image'));
    const image = chip(reader, 'image');
    await expect(image.locator('a, img, canvas, video')).toHaveCount(0);
    await image.getByText('Show Typed image descriptor (metadata only)', { exact: true }).click();
    await expect(image).toContainText('sha256');
    await page.screenshot({ path: testInfo.outputPath(`combined-expanded-${viewport.width}.png`) });
    const geometry = await reader.evaluate(owner => ({
      nested: [...owner.querySelectorAll<HTMLElement>('*')].filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1).map(el => el.className),
      horizontal: document.documentElement.scrollWidth > innerWidth + 1,
      bodyFont: getComputedStyle(owner.querySelector('.msg-body')!).fontSize,
      actionFont: getComputedStyle(owner.querySelector('.tool-chip-action')!).fontSize,
    }));
    expect(geometry).toEqual({ nested: [], horizontal: false, bodyFont: '15px', actionFont: '15px' });
    const contrast = await reader.evaluate(owner => {
      const rgba = (value: string) => value.match(/[\d.]+/g)!.map(Number);
      const luminance = (rgb: number[]) => rgb.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
      return [...owner.querySelectorAll<HTMLElement>('.msg-body, .round-head, .tool-chip-action, .tool-chip-status, summary, .semantic-section a, .semantic-section dt')].filter(el => el.getBoundingClientRect().height > 0).map(el => {
        const layers: number[][] = [];
        for (let ancestor: HTMLElement | null = el; ancestor; ancestor = ancestor.parentElement) layers.unshift(rgba(getComputedStyle(ancestor).backgroundColor));
        let bg = [255, 255, 255];
        for (const layer of layers) bg = bg.map((value, index) => layer[index]! * (layer[3] ?? 1) + value * (1 - (layer[3] ?? 1)));
        const fg = luminance(rgba(getComputedStyle(el).color)), back = luminance(bg);
        return { label: el.className || el.tagName, ratio: (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05) };
      });
    });
    expect(contrast.filter(sample => sample.ratio < 4.5)).toEqual([]);
    for (const half of ['call', 'result'] as const) {
      await page.goto(`/agents/${executor}?segment=1&entry=${encodeURIComponent(rowId('run', half === 'result'))}`);
      const anchor = reader.locator('.targeted-conversation-entry');
      await expect(anchor).toHaveAttribute('data-entry-id', rowId('run', half === 'result'));
      await expect(anchor).toBeFocused();
      await expect(chip(reader, 'run').locator('.tool-chip-toggle')).toHaveAttribute('aria-expanded', 'true');
      await page.reload(); await expect(anchor).toBeFocused();
    }
    await page.goBack();
    await expect(reader.locator('.targeted-conversation-entry')).toBeFocused();
    expect(rest.unknown).toEqual([]);
  });
}
