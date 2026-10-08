import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const command = `npm test -- ${'long_unbroken_argument_'.repeat(160)} --final-character-Z`;
const evidence = fileURLToPath(new URL('../../../docs/working/2026-10-07-conversation-reading-ux/evidence/compact-summary/', import.meta.url));
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

// Exercise the real shared row in both owners; character budgets alone cannot
// establish compactness. Keep auxiliary links/later-result outside toggle height.
async function summaryGeometry(row: Locator) {
  return row.evaluate(el => {
    const button = el.querySelector<HTMLElement>('.tool-chip-toggle')!;
    const target = el.querySelector<HTMLElement>('.tool-chip-target')!;
    const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const parts = ['action', 'target', 'status'].map(name => rect(el.querySelector(`.tool-chip-${name}`)!));
    const lineHeight = parseFloat(getComputedStyle(target).lineHeight);
    const rgba = (value: string) => value.match(/[\d.]+/g)!.map(Number);
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const contrast = [...el.querySelectorAll<HTMLElement>('.tool-chip-action, .tool-chip-target, .tool-chip-status')].map(part => {
      const layers: number[][] = [];
      for (let ancestor: HTMLElement | null = part; ancestor; ancestor = ancestor.parentElement) layers.unshift(rgba(getComputedStyle(ancestor).backgroundColor));
      let bg = [255, 255, 255];
      for (const layer of layers) bg = bg.map((value, index) => layer[index]! * (layer[3] ?? 1) + value * (1 - (layer[3] ?? 1)));
      const fg = luminance(rgba(getComputedStyle(part).color)), back = luminance(bg);
      return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
    });
    return { paneWidth: el.closest('.conversation-reading-surface, .chat-scroll-area')!.clientWidth,
      row: rect(el), button: rect(button), target: rect(target), parts, lineHeight,
      font: getComputedStyle(target).fontSize, contrast,
      auxiliary: [...el.querySelectorAll('.tool-chip-links, .later-result')].map(rect),
      overflow: button.scrollWidth > button.clientWidth + 1,
      overlap: parts.some((a, i) => parts.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1)) };
  });
}
async function captureCompact(page: Page, owner: Locator, row: Locator, following: Locator, directory: string, name: string) {
  await row.evaluate(el => {
    const owner = el.closest<HTMLElement>('.conversation-reading-surface, .chat-scroll-area')!;
    owner.scrollTop += el.getBoundingClientRect().top - owner.getBoundingClientRect().top - 12;
  });
  const visible = await owner.evaluate((el, ids) => {
    const bounds = el.getBoundingClientRect();
    return ids.map(id => { const r = el.querySelector(`[data-${id[0]}="${id[1]}"]`)!.getBoundingClientRect(); return r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1; });
  }, [['tool-entry-id', (await row.getAttribute('data-tool-entry-id'))!], ['entry-id', (await following.getAttribute('data-entry-id'))!]]);
  expect(visible, 'whole closed row and following message visible').toEqual([true, true]);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.geometry.json`), JSON.stringify(await summaryGeometry(row), null, 2));
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1296, height: 899 }, { width: 900, height: 700 }, { width: 390, height: 844 }]) {
  for (const surface of ['inspector', 'analyst'] as const) {
    test(`compact summaries ${surface} ${viewport.width}x${viewport.height}`, async ({ page, context }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await seedTokenBeforeNavigation(page, 'synthetic-semantic-token');
      const requests: string[] = [];
      page.on('request', request => requests.push(new URL(request.url()).pathname));
      await installOperatorWebSocketShim(page);
      const rest = await installOperatorRestRoutes(page);
      // The mobile card header + participant rail leave too little height for
      // a whole row and following prose simultaneously. Use the existing global
      // inspector at this width, not a hidden/modified rail or a synthetic pane.
      const session = surface === 'inspector' && viewport.width !== 390 ? executor : analyst;
      const exitedProcess = validateProcessToolResult({ process_id: processId, status: 'exited', exit_code: 0, stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0, stdout_complete: true, stderr_complete: true,
        stdout_url: `work:///processes/${processId}/stdout.log`, stderr_url: `work:///processes/${processId}/stderr.log` });
      const cases = [12, 160].flatMap(size => {
        const command = `npm test -- ${'long_unbroken_argument_'.repeat(size)} FINAL-COMMAND-Z`;
        const path = `src/${'shared_scope/'.repeat(size)}meaningful-filename.ts`;
        const query = `specific query ${'retained_query_'.repeat(size)} FINAL-QUERY-Q`;
        const error = `File not found: ${'retained_error_'.repeat(size)} FINAL-ERROR-E`;
        const accepted = JSON.parse(rows(session).find(e => e.id === rowId('accept', true))!.content);
        accepted.data.propagation.error = `Ancestor notification refused: ${'retained_reason_'.repeat(size)} FINAL-PROPAGATION-P`;
        accepted.data = RecordMutationSuccessSchema.parse({ kind: 'applied', data: accepted.data }).data;
        return [
          { id: `command-${size}`, tool: 'run_command', args: { command }, result: { success: true, data: exitedProcess }, full: command, simple: true },
          { id: `path-${size}`, tool: 'read', args: { path }, result: { success: false, error }, full: path, simple: false },
          { id: `query-${size}`, tool: 'websearch', args: { query }, result: { success: true, data: { query, results: [] } }, full: query, simple: false },
          { id: `uncertain-${size}`, tool: 'edit', args: { path, old_string: 'before', new_string: 'after' }, result: { success: false, data: { outcome_unknown: true }, error }, full: error, simple: false },
          { id: `accept-${size}`, tool: 'write', args: { path: recordUrl, content: 'Accepted content.' }, result: accepted, full: accepted.data.propagation.error as string, simple: false },
        ];
      });
      const control = pair(session, 'control', 'run_command', { command: 'npm test' }, { success: true, data: exitedProcess });
      const entries = [...control, text(session, 'following-control', 'Following short command.'),
        ...cases.flatMap(c => [...pair(session, c.id, c.tool, c.args, c.result), text(session, `following-${c.id}`, `Following ${c.id}.`)]),
        ...rows(session).filter(e => e.id === rowId('accept') || e.id === rowId('accept', true) || e.id === rowId('image') || e.id === rowId('image', true)),
        text(session, 'following-image', 'Following image metadata.'),
        ...Array.from({ length: 8 }, (_, i) => text(session, `compact-tail-${i}`, `Following retained context ${i}.`))];
      await page.route('**/api/agents/*/conversation**', async route => {
        const url = new URL(route.request().url());
        if (decodeURIComponent(url.pathname.split('/')[3]!) !== session || url.pathname.endsWith('/versions')) return route.fallback();
        const history = url.pathname.endsWith('/versions/1');
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(history
          ? parseOperatorResponse('agents.conversationVersions.get', 200, { session_id: session, version: 1, entry_id: segment, published_at: timestamp, segment_context: null, entries })
          : parseOperatorResponse('agents.conversation', 200, { session_id: session, segment_id: segment, segment_version: 1, segment_context: null, entries, cursor: { segment_id: segment, segment_version: 1, message_id: entries.at(-1)!.id } })) });
      });
      await page.goto(surface === 'inspector' ? `/agents/${session}?segment=1` : '/dashboard');
      if (surface === 'analyst' && viewport.width === 390) await page.getByRole('navigation', { name: 'Switch pane' }).getByRole('button', { name: 'Analyst', exact: true }).click();
      const owner = page.locator(surface === 'inspector' ? '.conversation-reading-surface' : '.analyst-chat-panel .chat-scroll-area');
      await expect(chip(owner, 'command-160')).toBeAttached();
      const directory = join(evidence, `${viewport.width}x${viewport.height}`);
      mkdirSync(directory, { recursive: true });
      if (surface === 'inspector' && viewport.width === 390) await expect(page.locator('.global-session-reader')).toBeVisible();
      writeFileSync(join(directory, `${surface}-context.json`), JSON.stringify({ surface, session, route: page.url(), inspectorContext: surface === 'inspector' ? viewport.width === 390 ? 'existing global Analyst session inspector' : 'child card inspector' : null }, null, 2));
      const metrics = new Map<string, Awaited<ReturnType<typeof summaryGeometry>>>();
      for (const id of ['control', ...cases.map(c => c.id)]) {
        const row = chip(owner, id), metric = await summaryGeometry(row);
        metrics.set(id, metric);
        expect(metric.font).toBe('15px');
        expect(metric.contrast.every(ratio => ratio >= 4.5)).toBe(true);
        expect(metric.target.height).toBeLessThanOrEqual(metric.lineHeight + 1);
        expect(metric.target.width).toBeGreaterThanOrEqual(64);
        expect(metric.overlap).toBe(false); expect(metric.overflow).toBe(false);
        if (id === 'control' || id.startsWith('command-')) {
          const lines = metric.paneWidth >= 450 ? 2 : 3;
          expect(metric.button.height).toBeLessThanOrEqual(lines * metric.lineHeight + 12 + (lines - 1) * 8 + 1);
        }
      }
      for (const family of ['command', 'path', 'query', 'uncertain', 'accept']) {
        expect(Math.abs(metrics.get(`${family}-12`)!.button.height - metrics.get(`${family}-160`)!.button.height), `${family}: payload-length independent toggle`).toBeLessThan(1);
        expect(Math.abs(metrics.get(`${family}-12`)!.row.height - metrics.get(`${family}-160`)!.row.height), `${family}: payload-length independent whole row`).toBeLessThan(1);
      }
      writeFileSync(join(directory, `${surface}-all-summaries.geometry.json`), JSON.stringify(Object.fromEntries(metrics), null, 2));
      await expect(chip(owner, 'control').locator('.tool-chip-target')).toHaveText('npm test');
      await expect(chip(owner, 'command-160').locator('.tool-chip-target')).toContainText('npm test -- long_unbroken_argument_');
      await expect(chip(owner, 'accept')).toContainText('Record accepted');
      await expect(chip(owner, 'accept')).toContainText('Partial propagation');
      await expect(chip(owner, 'accept-160')).toContainText('Record accepted');
      await expect(chip(owner, 'accept-160')).toContainText('Partial propagation');
      await expect(chip(owner, 'uncertain-160')).toContainText('Effects uncertain');
      for (const [id, name] of [['control', 'short-control'], ['command-12', 'default-hundreds'], ['command-160', 'default'], ['path-160', 'failure'], ['uncertain-160', 'uncertainty'], ['image', 'image']] as const) {
        await captureCompact(page, owner, chip(owner, id), owner.locator(`[data-entry-id="following-${id}"]`), directory, `${surface}-${name}`);
      }
      for (const c of cases.filter(c => c.id.endsWith('-160'))) {
        const row = chip(owner, c.id), toggle = row.locator('.tool-chip-toggle');
        await toggle.focus(); await toggle.press('Enter');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const focus = await toggle.evaluate(el => ({ width: getComputedStyle(el).outlineWidth, style: getComputedStyle(el).outlineStyle }));
        expect(focus).toEqual({ width: '2px', style: 'solid' });
        writeFileSync(join(directory, `${surface}-${c.id}-focus.json`), JSON.stringify(focus, null, 2));
        await row.locator('.semantic-section details').evaluateAll(es => es.forEach(e => { (e as HTMLDetailsElement).open = true; }));
        await expect(row.locator('.semantic-section').filter({ hasText: c.full }).first()).toBeAttached();
        expect(await row.locator('.semantic-section').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining(c.full)]));
        await expect(row.locator('[data-entry-id]')).toHaveCount(2);
        for (const half of ['request', 'result'] as const) {
          const raw = row.locator(`.tool-${half} .safe-original`);
          await raw.locator('summary').click();
          await expect(raw.locator('pre')).toHaveClass(/language-json/);
          await raw.getByRole('button', { name: 'copy', exact: true }).click();
          const exact = entries.find(e => e.id === rowId(c.id, half === 'result'))!.content;
          await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(exact);
        }
        if (c.id === 'command-160') {
          await toggle.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(directory, `${surface}-expanded-detail.png`), animations: 'disabled' });
          const commandBlock = row.locator('.tool-request .semantic-section').filter({ has: page.getByRole('heading', { name: 'command', exact: true }) }).locator('.code-block pre code');
          await expect(commandBlock).toHaveText(c.full);
          for (const edge of ['start', 'end'] as const) {
            // Scroll only the actual reading owner to a range in the semantic
            // command, never a RAW block, body or an unconstrained ancestor.
            const geometry = await commandBlock.evaluate(async (code, { full, edge }) => {
              const text = code.firstChild!;
              if (text.textContent !== full) throw new Error('Semantic command is not the complete exact supplied string');
              const owner = code.closest<HTMLElement>('.conversation-reading-surface, .chat-scroll-area')!;
              const range = document.createRange();
              const start = edge === 'start' ? 0 : full.length - 'FINAL-COMMAND-Z'.length;
              const end = edge === 'start' ? Math.min(24, full.length) : full.length;
              range.setStart(text, start); range.setEnd(text, end);
              const before = range.getBoundingClientRect(), bounds = owner.getBoundingClientRect();
              owner.scrollTop += before.top - bounds.top - owner.clientTop - (owner.clientHeight - before.height) / 2;
              await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
              const ownerBounds = owner.getBoundingClientRect();
              const top = ownerBounds.top + owner.clientTop;
              const footer = document.querySelector('.mobile-pane-switch')!.getBoundingClientRect();
              const bottom = Math.min(top + owner.clientHeight, innerHeight, footer.height > 0 ? footer.top : innerHeight);
              const fragments = [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }));
              return { edge, excerpt: range.toString(), fullCharacterCount: full.length,
                owner: { classes: owner.className, top, bottom, width: owner.clientWidth, scrollTop: owner.scrollTop, scrollHeight: owner.scrollHeight },
                font: getComputedStyle(code).fontSize, fragments,
                visible: fragments.length > 0 && fragments.every(r => r.width > 0 && r.height > 0 && r.top >= top && r.bottom <= bottom && r.left >= ownerBounds.left && r.right <= ownerBounds.right),
                nestedScrollOwners: [...owner.querySelectorAll('*')].filter(el => /auto|scroll/.test(getComputedStyle(el).overflowY)).map(el => el.className) };
            }, { full: c.full, edge });
            expect(geometry.excerpt).toBe(edge === 'start' ? c.full.slice(0, 24) : 'FINAL-COMMAND-Z');
            expect(geometry.visible, `${surface}: semantic command ${edge} characters visible in the reading owner`).toBe(true);
            expect(geometry.nestedScrollOwners).toEqual([]);
            expect(geometry.font).toBe('15px');
            writeFileSync(join(directory, `${surface}-expanded-detail-${edge}.geometry.json`), JSON.stringify(geometry, null, 2));
            await page.screenshot({ path: join(directory, `${surface}-expanded-detail-${edge}.png`), animations: 'disabled' });
          }
        }
        await toggle.focus(); await toggle.press('Space');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      }
      await expect(chip(owner, 'image').locator('a, img, canvas, video')).toHaveCount(0);
      expect(await owner.evaluate(el => [...el.querySelectorAll('*')].filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).map(e => e.className))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
      // Exact reveal remains the inspector route's owner, including global sessions.
      for (const result of [false, true]) {
        await page.goto(`/agents/${session}?segment=1&entry=${encodeURIComponent(rowId('command-160', result))}`);
        const revealed = page.locator('.conversation-reading-surface .targeted-conversation-entry');
        await expect(revealed).toHaveAttribute('data-entry-id', rowId('command-160', result));
        await expect(revealed).toBeFocused();
      }
      expect(rest.unknown).toEqual([]);
      expect(requests.some(path => /\/images\/|screen\.png/.test(path))).toBe(false);
    });
  }
}

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
