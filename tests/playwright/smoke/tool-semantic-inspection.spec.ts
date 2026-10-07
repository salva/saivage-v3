import { expect, test, type Locator, type Page } from '@playwright/test';
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
const stdout = 'Recorded stdout head\nlast stdout character Z';
const stderr = 'Recorded failure: assertion mismatch\nlast stderr character Q';
const recordUrl = `record:///status.md?card=${smokeCardId}`;

function text(session: string, id: string, content: string) {
  return { id, session_id: session, role: 'assistant', kind: 'text', content,
    context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
    round_id: `r-assistant-${segment.replaceAll('-', '')}`, message_index: 0, block_index: 0, timestamp };
}
function pair(session: string, id: string, tool: string, args: object, result: object) {
  const content = JSON.stringify(result);
  const policy = toolRowPolicies({ content });
  const base = { session_id: session, tool, tool_call_id: id, message_index: 0, block_index: 0, timestamp };
  return [
    { ...base, id: `${segment}:tool-call:${id}`, role: 'assistant', kind: 'tool_call', round_id: `r-assistant-${segment.replaceAll('-', '')}`, context_policy: policy.call,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }) },
    { ...base, id: `${segment}:tool-result:${id}`, role: 'tool', kind: 'tool_result', round_id: 'r-assistant-22222222222242228222222222222222', context_policy: policy.result, content },
  ];
}
function rows(session: string) {
  const output = validateProcessToolResult({ process_id: processId, status: 'running', exit_code: null,
    stdout, stderr: '', stdout_bytes: 4096, stderr_bytes: 0, stdout_complete: false, stderr_complete: true,
    stdout_url: `work:///processes/${processId}/stdout.log`, stderr_url: `work:///processes/${processId}/stderr.log` });
  const run = pair(session, 'run', 'run_command', { command, wait: false }, { success: true, data: output });
  const draft = RecordMutationSuccessSchema.parse({ kind: 'applied', data: { card_id: smokeCardId, name: 'status.md', state: 'open', surface: 'card_agent', revision: 7,
    head_id: '33333333-3333-4333-8333-333333333333', current_url: recordUrl, accepted_version_url: `${recordUrl}&v=4`, bytes: 14, written: true } }).data;
  const acceptance = RecordMutationSuccessSchema.parse({ kind: 'applied', data: { ...draft, state: 'closed', surface: 'analyst', revision: 8,
    head_id: '44444444-4444-4444-8444-444444444444', bytes: 17, accepted_version_url: `${recordUrl}&v=8`, propagation: { ok: false, partial: true, error: 'Ancestor notification refused' } } }).data;
  return [run[0]!, text(session, 'intervening-prose', 'Correction before the process observation.'), run[1]!,
    ...pair(session, 'wait', 'wait_process', { process_id: processId, timeout_ms: 0 }, { success: true, data: validateProcessToolResult({ ...output, status: 'exited', exit_code: 1, stderr, stderr_bytes: Buffer.byteLength(stderr) }) }),
    ...pair(session, 'edit', 'edit', { path: 'src/example.ts', old_string: 'old supplied text', new_string: 'new supplied text', replace_all: true }, { success: true, data: { path: 'src/example.ts', replacements: 2, bytes: 38, edited: true } }),
    ...pair(session, 'draft', 'write', { path: recordUrl, content: 'Draft content.' }, { success: true, data: draft }),
    ...pair(session, 'accept', 'write', { path: recordUrl, content: 'Accepted content.' }, { success: true, data: acceptance }),
    ...pair(session, 'notice', 'queue_notification', { card_id: smokeCardId, kind: 'context', urgency: 'urgent', body: 'Review the observed failure.' }, { success: true, data: { queued: true, card_id: smokeCardId, notification_id: '55555555-5555-4555-8555-555555555555', body: 'Review the observed failure.', interruption: { status: 'pending_tool_settlement' } } }),
    ...pair(session, 'restart', 'restart_server', {}, { success: true, data: { restart: 'confirmation_required', confirmationMessage: 'Send RESTART SERVER to confirm.' } }),
    ...pair(session, 'uncertain', 'edit', { path: 'src/uncertain.ts', old_string: 'before', new_string: 'after' }, { success: false, data: { outcome_unknown: true }, error: 'Prior effects may or may not have occurred.' }),
    ...pair(session, 'missing', 'read', { path: 'missing.txt' }, { success: false, error: 'File not found: missing.txt' }),
    pair(session, 'unmatched', 'wait_process', { process_id: processId }, { success: true })[0]!,
    pair(session, 'retained-result', 'wait_process', { process_id: processId }, { success: true, data: output })[1]!,
    ...Array.from({ length: 24 }, (_, i) => text(session, `tail-${i}`, `Retained tail row ${i}: ${'observational context '.repeat(12)}`)),
  ];
}

async function setup(page: Page) {
  await seedTokenBeforeNavigation(page, 'synthetic-semantic-token');
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  const reads: string[] = [];
  let arrivals = false;
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) reads.push(request.url()); });
  await page.route('**/api/agents/*/conversation**', async (route) => {
    const url = new URL(route.request().url());
    const session = decodeURIComponent(url.pathname.split('/')[3]!);
    if (![executor, analyst].includes(session) || url.pathname.endsWith('/versions')) return route.fallback();
    const entries = [...rows(session), ...(arrivals ? [text(session, 'arrival', 'New current arrival.')] : [])];
    const history = url.pathname.endsWith('/versions/1');
    const body = history ? parseOperatorResponse('agents.conversationVersions.get', 200, { session_id: session, version: 1, entry_id: segment, published_at: timestamp, segment_context: null, entries })
      : parseOperatorResponse('agents.conversation', 200, { session_id: session, segment_id: segment, segment_version: 1, segment_context: null, entries,
        cursor: { segment_id: segment, segment_version: 1, message_id: entries.at(-1)!.id } });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { rest, reads, arrive: () => { arrivals = true; } };
}
const rowId = (id: string, result = false) => `${segment}:tool-${result ? 'result' : 'call'}:${id}`;
function exact(reader: Locator, id: string) { return reader.locator(`[data-entry-id="${id}"]`); }
async function expand(chip: Locator) {
  const toggle = chip.locator('.tool-chip-toggle');
  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
}
async function copyExact(page: Page, block: Locator, expected: string) {
  await block.getByRole('button', { name: 'copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 700 }]) {
  test(`recorded tool semantics, exact anchors and independent inspection at ${viewport.width}x${viewport.height}`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const fixture = await setup(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/agents/${executor}?segment=1`);
    const reader = page.getByTestId('route-cockpit').locator('.conv-rounds');
    await expect(reader.locator('[data-entry-id]')).toHaveCount(rows(executor).length);
    expect(await reader.locator('[data-entry-id]').evaluateAll((elements) => elements.map((e) => e.getAttribute('data-entry-id')))).toEqual(rows(executor).map((e) => e.id));
    await expect(exact(reader, rowId('run'))).toContainText('Requested Run command');
    await expect(exact(reader, rowId('run', true))).toContainText('Running at observation');
    await expect(exact(reader, rowId('wait', true))).toContainText('Process failed · exit 1');
    await expect(exact(reader, rowId('wait', true))).toContainText('assertion mismatch');
    await expect(exact(reader, rowId('missing', true))).toContainText('File not found: missing.txt');
    await expect(exact(reader, rowId('unmatched'))).toContainText('No result recorded');
    await expect(exact(reader, rowId('retained-result', true))).toContainText('Requested context unavailable');
    await expect(exact(reader, rowId('accept', true))).toContainText('Record accepted');
    await expect(exact(reader, rowId('accept', true))).toContainText('Partial propagation · Ancestor notification refused');
    await expect(exact(reader, rowId('notice', true))).toContainText('Queued · Delivery not reported');
    await expect(exact(reader, rowId('notice', true))).toContainText('pending_tool_settlement');
    await expect(exact(reader, rowId('restart', true))).toContainText('confirmation_required · Send RESTART SERVER');
    await expect(exact(reader, rowId('uncertain', true))).toContainText('Effects uncertain');
    await reader.evaluate((e) => { e.scrollTop = 0; });
    await page.getByTestId('chat-scroll-container').evaluate((e) => { e.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath('cockpit-conversations-semantic-candidate.png'), fullPage: false });

    const run = exact(reader, rowId('run'));
    await expand(run);
    await expect(run.locator('.semantic-section')).toContainText(['Requested command', 'command']);
    await expect(run.getByText(command, { exact: true })).toBeVisible();
    await run.getByRole('button', { name: 'Safe original request', exact: true }).click();
    await copyExact(page, run.locator('.tool-chip-raw'), rows(executor)[0]!.content);
    await run.locator('.tool-chip-toggle').press('Space');
    await expect(run.locator('.tool-chip-detail')).toHaveCount(0);

    const wait = exact(reader, rowId('wait', true));
    const before = fixture.reads.length;
    await expand(wait);
    await expect(wait.getByRole('heading', { name: 'Recorded process', exact: true })).toBeVisible();
    const stdoutSection = wait.locator('.semantic-section').filter({ has: page.getByRole('heading', { name: 'stdout', exact: true }) });
    const stderrSection = wait.locator('.semantic-section').filter({ has: page.getByRole('heading', { name: 'stderr', exact: true }) });
    await stdoutSection.locator('summary').focus();
    await stdoutSection.locator('summary').press('Enter');
    await expect(stdoutSection.locator('details')).toHaveAttribute('open', '');
    await expect(stderrSection.locator('details')).not.toHaveAttribute('open', '');
    await copyExact(page, stdoutSection.locator('.code-block'), stdout);
    await stderrSection.locator('summary').focus();
    await stderrSection.locator('summary').press('Space');
    await copyExact(page, stderrSection.locator('.code-block'), stderr);
    await expect(wait).toContainText('Head completefalse');
    const output = wait.getByRole('link', { name: 'stderr Files', exact: true });
    await output.focus();
    await expect(output).toBeFocused();
    const href = new URL((await output.getAttribute('href'))!, page.url());
    expect(href.pathname).toBe('/files');
    expect(href.searchParams.get('path')).toBe(`.saivage/work/processes/${processId}/stderr.log`);
    await wait.getByRole('button', { name: 'Safe original result', exact: true }).click();
    await copyExact(page, wait.locator('.tool-chip-raw'), rows(executor).find((e) => e.id === rowId('wait', true))!.content);
    expect(fixture.reads.length).toBe(before);

    const semanticReads = fixture.reads.length;
    const edit = exact(reader, rowId('edit'));
    await expand(edit);
    await expect(edit.getByText('old supplied text', { exact: true })).toBeVisible();
    await expect(edit.getByText('new supplied text', { exact: true })).toBeVisible();
    const editResult = exact(reader, rowId('edit', true));
    await expand(editResult);
    await expect(editResult).toContainText('2 replacements');
    const draft = exact(reader, rowId('draft', true));
    await expand(draft);
    await expect(draft).toContainText('Draft updated');
    await expect(draft).toContainText('Mutable revision7');
    await expect(draft).toContainText('Retained accepted version');
    await expect(draft.getByRole('link').filter({ hasText: '&v=4' })).toHaveCount(1);
    const accept = exact(reader, rowId('accept', true));
    await expand(accept);
    await expect(accept.getByRole('heading', { name: 'Propagation (separate from principal effect)' })).toBeVisible();
    await expect(accept).toContainText('Ancestor notification refused');
    expect(fixture.reads.length).toBe(semanticReads);

    const analystReader = page.locator('.analyst-chat-panel .conversation-timeline');
    await expect(analystReader.locator('[data-entry-id]')).toHaveCount(rows(analyst).length);
    expect(await analystReader.locator('[data-entry-id]').evaluateAll((es) => es.map((e) => e.getAttribute('data-entry-id')))).toEqual(rows(analyst).map((e) => e.id));
    await expect(exact(analystReader, rowId('uncertain', true))).toContainText('Effects uncertain');
    await expand(exact(analystReader, rowId('draft', true)));
    await expect(exact(analystReader, rowId('draft', true))).toContainText('Retained accepted version');

    const targetUrl = `/agents/${executor}?segment=1&entry=${encodeURIComponent(rowId('wait', true))}`;
    const mate = exact(reader, rowId('run')).getByRole('button', { name: 'Result recorded below', exact: true });
    await mate.focus();
    await mate.press('Enter');
    await expect(exact(reader, rowId('run', true))).toBeFocused();
    await page.goto(targetUrl);
    await expect(exact(reader, rowId('wait', true))).toHaveClass(/targeted-conversation-entry/);
    await expect(exact(reader, rowId('wait', true))).toBeFocused();
    await page.reload();
    await expect(exact(reader, rowId('wait', true))).toHaveClass(/targeted-conversation-entry/);
    await page.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page).toHaveURL(`/cards/${smokeCardId}`);
    await page.goBack();
    await expect(page).toHaveURL(targetUrl);
    await expect(exact(reader, rowId('wait', true))).toHaveClass(/targeted-conversation-entry/);
    const scroll = reader;
    await scroll.evaluate((e) => { e.scrollTop = 120; });
    const offset = await scroll.evaluate((e) => e.scrollTop);
    fixture.arrive();
    const readCount = fixture.reads.length;
    const refresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return decodeURIComponent(url.pathname) === `/api/agents/${executor}/conversation`;
    });
    await page.evaluate((id) => window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, visible_message_id: 'arrival' }), executor);
    expect((await (await refresh).json()).cursor.message_id).toBe('arrival');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => fixture.reads.length).toBeGreaterThan(readCount);
    await expect(exact(reader, rowId('wait', true))).toHaveClass(/targeted-conversation-entry/);
    expect(await scroll.evaluate((e) => e.scrollTop)).toBe(offset);
    expect(errors).toEqual([]);
    expect(fixture.rest.unknown).toEqual([]);
  });
}
