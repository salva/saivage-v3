import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeCardId, retainedInstructionContext } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';
import { toolRowPolicies } from '../../helpers/row-policy-fixtures.js';
import { redactTextForOutbound } from '../../../src/redaction/index.js';
import { MODEL_RECOVERY_NOTICE_TEXT } from '../../../src/schemas/context-policy.js';

const token = 'synthetic-cockpit-conversation-token';
const executor = `agent:executor:${smokeCardId}`;
const reviewer = `agent:reviewer:${smokeCardId}`;
const marker = '99999999-9999-4999-8999-999999999999';
const now = '2026-09-28T12:00:00.000Z';

for (const viewport of [{ width: 1440, height: 900 }, { width: 1296, height: 899 }, { width: 900, height: 700 }, { width: 390, height: 844 }]) {
  test(`selected genesis and recorded context remain independent and stable ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const rest = await setup(page);
    let mode = 0;
    let reads = 0;
    const context = retainedInstructionContext(executor);
    context.summary_text = redactTextForOutbound(`${'Actual historical summary. '.repeat(150)} token=summary-egress-canary final-summary-Z`);
    context.protected_prompts = Array.from({ length: 7 }, (_, index) => ({
      source: { segment_version: 1, row_index: index },
      message: { ...context.protected_prompts[0]!.message, id: `protected-${index}`, content: redactTextForOutbound(`Instruction ${index} token=instruction-egress-canary final-instruction-Z`) },
    }));
    const inheritedContext = { ...context,
      required_model_facts: { latestRecovery: { sourceMessageId: '11111111-1111-4111-8111-111111111111:model-recovered', activationInputId: '11111111-1111-4111-8111-111111111111' }, latestContentPolicyRefusal: { markerId: '33333333-3333-4333-8333-333333333333', activationInputId: '22222222-2222-4222-8222-222222222222' } },
      continuation: { kind: 'inherited_open_round', activation: { marker_id: 'real-inherited-marker', input_id: '11111111-1111-4111-8111-111111111111' }, active_segment_kind: 'initial' },
    };
    const pair = callRows('context-call', 'r-assistant-33333333333343338333333333333333', 0);
    const text = (id: string, content: string, role = 'assistant') => ({ ...context.protected_prompts[0]!.message, id, role, content,
      context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true } });
    const rows = [pair[0], text('recorded-system-row', 'Recorded node-looking text, not current authority. final-system-Z', 'system'),
      text('interleaved-prose', 'Correction before the result'), pair[1],
      { ...text('visible-diagnostic', '{"message":"visible recovery issue"}', 'system'), kind: 'model_issue', context_policy: { kind: 'structural', behavior: 'provider_failure' } },
      ...Array.from({ length: 35 }, (_, index) => text(`ongoing-${index}`, `Ongoing work ${index}. ${'Readable source prose. '.repeat(12)}`))];
    const identity = () => mode === 2 ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await page.route('**/api/agents/*/conversation**', async route => {
      const url = new URL(route.request().url());
      if (decodeURIComponent(url.pathname.split('/')[3]!) !== executor) return route.fallback();
      if (url.pathname.endsWith('/versions')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversationVersions.list', 200, {
        session_id: executor, versions: [
          { entry_id: '11111111-1111-4111-8111-111111111111', version: 1, published_at: now, genesis_kind: 'ordinary', source_version: null },
          { entry_id: identity(), version: 2, published_at: now, genesis_kind: 'compacted', source_version: 1 },
        ], total: 2,
      })) });
      if (url.pathname.endsWith('/versions/1')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversationVersions.get', 200, {
        session_id: executor, version: 1, entry_id: '11111111-1111-4111-8111-111111111111', published_at: now, segment_context: null, entries: [text('old-only-row', 'Exact old source, no current summary')],
      })) });
      reads++;
      const selectedRows = url.searchParams.has('since') ? [text('live-arrival', 'New live arrival')] : rows;
      const body = parseOperatorResponse('agents.conversation', 200, {
        session_id: executor, segment_id: identity(), segment_version: 2, segment_context: mode === 2 ? context : inheritedContext,
        entries: selectedRows, cursor: { segment_id: identity(), segment_version: 2, message_id: selectedRows.at(-1)!.id },
      });
      expect(JSON.stringify(body)).not.toMatch(/summary-egress-canary|instruction-egress-canary/);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(`/agents/${executor}`);
    const inspector = page.locator('.conversation-container');
    await expect(inspector.getByTestId('conversation-segment-context')).toContainText('inherited open round');
    if (viewport.width >= 1296) {
      const surface = inspector.locator('.conversation-reading-surface');
      await surface.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
      await expect.poll(() => surface.evaluate(el => {
        const owner = el.getBoundingClientRect();
        const action = el.querySelector('.tool-chip-main')!.getBoundingClientRect();
        return action.top >= owner.top && action.bottom <= owner.bottom;
      })).toBe(true);
    }
    await expect(inspector.getByRole('button', { name: 'Expand all', exact: true })).toHaveCount(0);
    await expect(inspector.getByRole('button', { name: 'Collapse all', exact: true })).toHaveCount(0);
    await expect(inspector.getByText('Pause auto-scroll', { exact: true })).toHaveCount(0);
    if (viewport.width === 390) await page.getByRole('navigation', { name: 'Switch pane' }).getByRole('button', { name: 'Analyst', exact: true }).click();
    await expect(page.getByLabel('Analyst chat composer')).toBeEnabled();
    await expect(page.getByRole('region', { name: 'Analyst chat', exact: true }).getByLabel('Pause auto-scroll')).toBeVisible();
    if (viewport.width === 390) await page.getByRole('navigation', { name: 'Switch pane' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    const genesis = inspector.getByTestId('conversation-segment-context');
    await expect(genesis).not.toHaveAttribute('open', '');
    await genesis.locator(':scope > summary').click();
    expect(await genesis.locator('details').evaluateAll(details => details.every(detail => !(detail as HTMLDetailsElement).open))).toBe(true);
    const summary = genesis.getByTestId('compacted-summary');
    await summary.locator('summary').focus(); await summary.locator('summary').press('Enter');
    await expect(summary.locator('pre')).toHaveText(context.summary_text);
    await expect(genesis.getByTestId('compacted-facts')).not.toHaveAttribute('open', '');
    const instructions = genesis.getByTestId('retained-instruction-context');
    await instructions.locator(':scope > summary').click();
    await instructions.locator('li').last().locator('summary').click();
    await expect(instructions.locator('li').last()).toContainText('Instruction 6 token=[REDACTED] final-instruction-Z');
    await genesis.getByTestId('compacted-facts').locator('summary').click();
    await expect(genesis.getByTestId('compacted-facts')).toContainText('33333333-3333-4333-8333-333333333333');
    await genesis.getByTestId('compacted-source').locator('summary').click();
    await expect(genesis.getByTestId('compacted-source')).toContainText('real-inherited-marker');
    const scroller = inspector.locator('.conv-rounds');
    await scroller.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    const anchors = await scroller.locator('[data-entry-id]').evaluateAll(elements => elements.slice(0, 5).map(el => (el as HTMLElement).dataset.entryId));
    expect(anchors).toEqual(['recorded-system-row', 'interleaved-prose', 'visible-diagnostic', 'ongoing-0', 'ongoing-1']);
    const recorded = scroller.locator('[data-entry-id="recorded-system-row"]');
    await expect(recorded.locator('details')).not.toHaveAttribute('open', '');
    await recorded.locator('summary').click();
    await expect(recorded).toContainText('final-system-Z');
    await expect(scroller.locator('[data-entry-id="visible-diagnostic"]')).toBeVisible();
    const before = await scroller.evaluate(el => el.scrollTop);
    await summary.locator('summary').click();
    expect(await scroller.evaluate(el => el.scrollTop)).toBeLessThan(before + 80);
    await summary.locator('summary').click();
    mode = 1;
    const priorReads = reads;
    await page.evaluate(id => window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', segment_version: 2, visible_message_id: 'live-arrival' }), executor);
    await expect.poll(() => reads).toBeGreaterThan(priorReads);
    await expect(summary).toHaveAttribute('open', '');
    await expect(recorded.locator('details')).toHaveAttribute('open', '');
    expect(await scroller.evaluate(el => el.scrollTop)).toBeLessThan(before + 80);
    await inspector.getByRole('button', { name: /Jump to latest/ }).click();
    await expect(scroller.getByText('New live arrival', { exact: true })).toBeVisible();
    mode = 2;
    await page.evaluate(id => window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', segment_version: 2, visible_message_id: 'replacement' }), executor);
    await expect(summary).not.toHaveAttribute('open', '');
    await expect(genesis).toContainText('between rounds');
    await inspector.locator('.version-history > summary').click();
    await inspector.getByRole('button', { name: /Segment 1/ }).click();
    await expect(scroller).toContainText('Exact old source, no current summary');
    await expect(inspector.getByTestId('conversation-segment-context')).toHaveCount(0);
    await expect(recorded).toHaveCount(0);
    await page.reload();
    await expect(scroller).toContainText('Exact old source, no current summary');
    await inspector.getByRole('button', { name: 'Current segment', exact: true }).click();
    await expect(genesis).toContainText('between rounds');
    await page.goto(`/agents/${executor}?entry=recorded-system-row`);
    await expect(recorded).toBeFocused();
    await expect(recorded.locator('details')).toHaveAttribute('open', '');
    expect(await page.locator('body').textContent()).not.toMatch(/summary-egress-canary|instruction-egress-canary/);
    expect(rest.unknown).toEqual([]);
  });
}

function activationRow(sessionId: string, suffix: string) {
  return { id: `${sessionId}:activation:${suffix}`, session_id: sessionId, role: 'system', kind: 'activity',
    content: JSON.stringify({ event: 'activation_open', agent_name: sessionId.split(':')[1], ...(sessionId.endsWith(':global') ? {} : { card_id: smokeCardId }), input_id: '11111111-1111-4111-8111-111111111111', timestamp: now }),
    context_policy: { kind: 'structural', behavior: 'activation_boundary' }, round_id: 'r-pre-11111111111141118111111111111111', message_index: 0, block_index: 0, timestamp: now };
}

function callRows(id: string, round: string, index: number, tool = 'read') {
  const content = 'synthetic-raw-response-only';
  const resultContent = JSON.stringify({ success: true, data: { path: 'README.md', content: { content, utf8_bytes: Buffer.byteLength(content), offset_bytes: 0, next_offset_bytes: Buffer.byteLength(content) }, total_bytes: Buffer.byteLength(content) } });
  const policies = toolRowPolicies({ content: resultContent });
  const source = round.slice('r-assistant-'.length).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  const base = { session_id: executor, tool, tool_call_id: id, round_id: round, message_index: index, block_index: 0, timestamp: now };
  return [
    { ...base, id: `${source}:tool-call:${id}`, role: 'assistant', kind: 'tool_call', context_policy: policies.call, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: base.tool_call_id, type: 'function', function: { name: tool, arguments: JSON.stringify({ path: 'README.md' }) } }] }) },
    { ...base, id: `${source}:tool-result:${id}`, role: 'tool', kind: 'tool_result', block_index: 1, context_policy: policies.result, content: resultContent },
  ];
}

async function setup(page: Page, chatBack = false) {
  await seedTokenBeforeNavigation(page, token);
  await installOperatorWebSocketShim(page);
  return installOperatorRestRoutes(page, chatBack ? {
    chatToolInvocations: [{ tool: 'navigate_back', params: {}, result: { success: true, data: { intent: 'navigate_back' } } }],
  } : {});
}

async function sendAnalyst(page: Page, text: string): Promise<void> {
  const input = page.getByLabel('Analyst chat composer');
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toBeEnabled();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: false });
}

const layoutCommand = `printf '%s\\n' ${'synthetic_unbroken_argument_'.repeat(7)} --full-raw-command-only`;
const layoutProcess = 'proc-012345abcdef';
const analyst = 'agent:analyst:global';

function layoutRows(sessionId: string) {
  const cases = [
    { tool: 'run_command', args: { command: layoutCommand }, result: { success: true, data: {
      process_id: layoutProcess, exit_code: 0, status: 'exited', stdout: 'Synthetic stdout head', stderr: 'Synthetic stderr head', stdout_bytes: 21, stderr_bytes: 100, stdout_complete: true, stderr_complete: false,
      stdout_url: `work:///processes/${layoutProcess}/stdout.log`, stderr_url: `work:///processes/${layoutProcess}/stderr.log`,
    } } },
    { tool: 'wait_process', args: { process_id: layoutProcess }, result: { success: true, data: {
      process_id: layoutProcess, exit_code: 1, status: 'exited', stdout: 'Synthetic stdout head', stderr: 'Synthetic exit failure', stdout_bytes: 100, stderr_bytes: 22, stdout_complete: false, stderr_complete: true,
      stdout_url: `work:///processes/${layoutProcess}/stdout.log`, stderr_url: `work:///processes/${layoutProcess}/stderr.log`,
    } } },
    { tool: 'run_command', args: { command: layoutCommand }, result: { success: false, error: `Synthetic command failed: ${'unbroken_failure_'.repeat(6)}` } },
    { tool: 'wait_process', args: { process_id: layoutProcess }, result: null },
  ];
  return cases.flatMap(({ tool, args, result }, index) => {
    const rows = callRows(`layout-${index}`, 'r-assistant-44444444444444448444444444444444', index, tool);
    const content = JSON.stringify(result);
    const policies = toolRowPolicies({ content });
    rows[0] = { ...rows[0]!, session_id: sessionId, context_policy: policies.call,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: `layout-${index}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }) };
    rows[1] = { ...rows[1]!, session_id: sessionId, context_policy: policies.result, content };
    return result === null ? rows.slice(0, 1) : rows;
  });
}

async function setupLayoutRows(page: Page) {
  const rest = await setup(page);
  await page.route('**/api/agents/*/conversation', async (route) => {
    const sessionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!);
    if (sessionId !== executor && sessionId !== analyst) return route.fallback();
    const entries = layoutRows(sessionId);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversation', 200, {
      session_id: sessionId, segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1,
      segment_context: null, entries, cursor: { segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, message_id: entries.at(-1)!.id },
    })) });
  });
  return rest;
}

// Only the target may ellipsize. Its initial painted characters must remain
// readable; actions, critical outcomes, buttons and links may never be clipped.
async function expectReadableToolRow(chip: Locator) {
  await chip.scrollIntoViewIfNeeded();
  const geometry = await chip.evaluate((row) => {
    const failures: string[] = [];
    const tolerance = 1;
    const contains = (owner: DOMRect, child: DOMRect) => child.left >= owner.left - tolerance
      && child.right <= owner.right + tolerance && child.top >= owner.top - tolerance && child.bottom <= owner.bottom + tolerance;
    const intersects = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance;
    const main = row.querySelector<HTMLElement>('.tool-chip-main')!;
    const toggle = row.querySelector<HTMLElement>('.tool-chip-toggle')!;
    const target = row.querySelector<HTMLElement>('.tool-chip-target')!;
    const targetRect = target.getBoundingClientRect(), targetStyle = getComputedStyle(target);
    const targetFont = parseFloat(targetStyle.fontSize), targetLine = parseFloat(targetStyle.lineHeight);
    if (targetRect.width < 64 || targetRect.height <= 1) failures.push('target has no readable nonzero slot');
    if (targetStyle.whiteSpace !== 'nowrap' || targetStyle.textOverflow !== 'ellipsis' || targetStyle.overflowX !== 'hidden') failures.push('target does not use the explicit single-line ellipsis policy');
    if (targetRect.height > targetLine + tolerance) failures.push('target occupies more than one line');
    if (targetFont < 14 || targetFont > 16) failures.push('target changed readable font size');
    if (!target.textContent?.trim()) failures.push('target has no meaningful text');
    let paintedPrefix = '';
    const targetWalker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    while (targetWalker.nextNode()) {
      const text = targetWalker.currentNode;
      for (let offset = 0; offset < (text.textContent?.length ?? 0); offset++) {
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
        const rects = [...range.getClientRects()];
        if (rects.length && rects.every(rect => contains(targetRect, rect))) paintedPrefix += text.textContent![offset];
      }
    }
    if (paintedPrefix.trim().length < Math.min(4, target.textContent!.trim().length)) failures.push('target initial characters are not visibly readable');
    if (!paintedPrefix.trim().startsWith(target.textContent!.trim().slice(0, 4))) failures.push('target lost its meaningful initial text');
    for (const owner of [main, toggle, ...row.querySelectorAll<HTMLElement>('.tool-chip-action, .tool-chip-status, .tool-chip-links, .inline-parts')].filter(el => !target.contains(el))) {
      const children = [...owner.children] as HTMLElement[];
      children.forEach((child, index) => {
        const rect = child.getBoundingClientRect();
        if (!contains(owner.getBoundingClientRect(), rect)) failures.push(`${child.className} escapes ${owner.className}`);
        if (!contains(row.getBoundingClientRect(), rect)) failures.push(`${child.className} escapes row`);
        for (const sibling of children.slice(index + 1)) {
          if (intersects(rect, sibling.getBoundingClientRect())) failures.push(`${child.className} overlaps ${sibling.className}`);
        }
      });
    }
    for (const owner of row.querySelectorAll<HTMLElement>('.tool-chip-toggle, .tool-chip-action, .tool-chip-status, .tool-chip-links')) {
      const font = parseFloat(getComputedStyle(owner).fontSize);
      if (font < 14 || font > 16) failures.push(`${owner.className} changed readable font size`);
      for (const boundary of [owner, ...owner.querySelectorAll<HTMLElement>('*')].filter(el => el !== target && !target.contains(el))) {
        const style = getComputedStyle(boundary);
        const clamp = style.getPropertyValue('-webkit-line-clamp');
        if (['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY) || (clamp !== 'none' && clamp !== '')) failures.push(`${boundary.className} clips non-target summary`);
      }
      const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (target.contains(text)) continue;
        for (let offset = 0; offset < (text.textContent?.length ?? 0); offset++) {
          if (/\s/u.test(text.textContent![offset]!)) continue;
          const range = document.createRange();
          range.setStart(text, offset);
          range.setEnd(text, offset + 1);
          for (const rect of range.getClientRects()) {
            const boundaries: HTMLElement[] = [];
            for (let boundary = text.parentElement; boundary; boundary = boundary.parentElement) {
              boundaries.push(boundary);
              if (boundary === row) break;
            }
            if (!boundaries.every(boundary => contains(boundary.getBoundingClientRect(), rect))) {
              failures.push(`${owner.className} text fragment escapes its wrapping owners`);
              break;
            }
          }
        }
      }
    }
    const next = row.parentElement?.querySelectorAll('.tool-chip');
    const following = next && [...next][[...next].indexOf(row) + 1];
    if (following && following.getBoundingClientRect().top < row.getBoundingClientRect().bottom - tolerance) failures.push('following row overlaps preceding content');
    return { violations: [...new Set(failures)], targetText: target.textContent, paintedPrefix, targetFont, targetWidth: targetRect.width, targetHeight: targetRect.height, targetLine };
  });
  expect(geometry.violations).toEqual([]);
  return geometry;
}

for (const viewport of [{ width: 1296, height: 899 }, { width: 1440, height: 900 }, { width: 900, height: 700 }, { width: 1920, height: 1080 }]) {
  test(`compact tool targets ellipsize without overflow, overlap or clipped outcomes at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const rest = await setupLayoutRows(page);
    await page.goto(`/agents/${executor}`);
    const chips = page.getByTestId('route-cockpit').locator('.tool-chip');
    await expect(chips).toHaveCount(4);
    await expect(chips.nth(0).locator('.tool-chip-status')).toContainText('Exited · exit 0');
    await expect(chips.nth(1).locator('.tool-chip-status')).toHaveAttribute('data-tone', 'error');
    await expect(chips.nth(2)).toContainText('Synthetic command failed');
    await expect(chips.nth(3).locator('.tool-chip-status')).toHaveText('No result recorded');
    await screenshot(page, testInfo, `tool-rows-${viewport.width}x${viewport.height}.png`);
    const inspectorGeometry = [];
    for (const chip of await chips.all()) inspectorGeometry.push(await expectReadableToolRow(chip));
    const analystChips = page.locator('.analyst-chat-panel .tool-chip');
    await expect(analystChips).toHaveCount(4);
    await screenshot(page, testInfo, `analyst-tool-rows-${viewport.width}x${viewport.height}.png`);
    const analystGeometry = [];
    for (const chip of await analystChips.all()) analystGeometry.push(await expectReadableToolRow(chip));
    await testInfo.attach('compact-summary-painted-text', { contentType: 'application/json', body: JSON.stringify({ inspectorGeometry, analystGeometry }, null, 2) });
    expect(rest.unknown).toEqual([]);
  });
}

test('tool disclosure and raw request retain native keyboard focus and separate output links', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1296, height: 899 });
  const rest = await setupLayoutRows(page);
  await page.goto(`/agents/${executor}`);
  const chip = page.getByTestId('route-cockpit').locator('.tool-chip').first();
  const toggle = chip.locator('button.tool-chip-toggle');
  await expect(toggle).toHaveAccessibleName('Expand tool run_command details');
  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
  expect(await toggle.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.matches(':focus-visible') && ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none');
  })).toBe(true);
  const detailsId = await toggle.getAttribute('aria-controls');
  await expect(chip.locator('.tool-chip-detail')).toHaveAttribute('id', detailsId!);
    const raw = chip.locator('.tool-request .safe-original > summary');
  for (let tabs = 0; tabs < 10 && !(await raw.evaluate((button) => button === document.activeElement)); tabs++) await page.keyboard.press('Tab');
  await expect(raw).toBeFocused();
  await raw.press('Enter');
  await expect(chip.locator('.tool-request .safe-original')).toContainText('synthetic_unbroken_argument_'.repeat(7));
  await expect(chip.locator('.tool-request .safe-original')).toContainText('--full-raw-command-only');
  await expect(toggle).toHaveAccessibleName('Collapse tool run_command details');
  await toggle.focus();
  await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await expect(chip.locator('.tool-chip-detail')).toHaveCount(0);
  const resultChip = page.getByTestId('route-cockpit').locator('.tool-chip').nth(1);
  await resultChip.locator('.tool-chip-toggle').focus();
  for (const stream of ['stdout', 'stderr']) {
    await page.keyboard.press('Tab');
    // Output links are semantic result evidence, not backdated call effects.
    if (stream === 'stdout') await resultChip.locator('.tool-chip-toggle').press('Enter');
    const link = resultChip.getByRole('link', { name: `${stream} Files`, exact: true });
    await link.focus();
    await expect(link).toBeFocused();
    await expect(link).toBeVisible();
    const href = new URL((await link.getAttribute('href'))!, page.url());
    expect(href.pathname).toBe('/files');
    expect(href.searchParams.get('root')).toBe('output');
    expect(href.searchParams.get('path')).toBe(`.saivage/work/processes/${layoutProcess}/${stream}.log`);
    expect(await link.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return element.matches(':focus-visible') && ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none')
        && (hit === element || element.contains(hit));
    })).toBe(true);
  }
  await screenshot(page, testInfo, 'tool-row-keyboard-output-focus.png');
  expect(rest.unknown).toEqual([]);
});

test('card conversations retain cockpit context through automatic, explicit, facet, and browser navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rest = await setup(page);
  await page.goto('/');
  await expect(page.getByTestId('facet-overview')).toBeVisible();
  const siblingToggle = page.getByRole('button', { name: 'Expand Synthetic sibling goal', exact: true });
  await siblingToggle.focus();
  await expect(siblingToggle).toBeFocused();
  await siblingToggle.click();
  const expandedSibling = page.locator('.tree-node').filter({ hasText: 'Expanded sibling child' });
  await expect(expandedSibling).toBeVisible();
  const conversationsTab = page.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Conversations', exact: true });
  await conversationsTab.focus();
  await expect(conversationsTab).toBeFocused();
  await conversationsTab.press('Enter');

  await expect(page).toHaveURL(`/agents/${executor}`);
  const cockpit = page.getByTestId('route-cockpit');
  await expect(cockpit).toHaveCount(1);
  await expect(cockpit.getByTestId('card-flow-id')).toHaveText(smokeCardId);
  await expect(cockpit.getByTestId('cockpit-facet-nav')).toContainText('OverviewConversationsRecords & HistoryEvidence');
  await expect(cockpit.locator('.conversation-container')).toHaveCount(1);
  await expect(cockpit.locator('.tree-node.selected')).toContainText('Synthetic dashboard smoke card');
  await expect(expandedSibling).toBeVisible();
  await expect(cockpit.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Conversations', exact: true })).toHaveClass(/active/);
  await expect(page.getByLabel('Analyst chat composer')).toBeVisible();

  const reviewerButton = cockpit.getByRole('button', { name: new RegExp(reviewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  await reviewerButton.focus();
  await expect(reviewerButton).toBeFocused();
  await reviewerButton.press('Enter');
  await expect(page).toHaveURL(`/agents/${reviewer}`);
  await expect(cockpit.locator('.conversation-container')).toHaveCount(1);
  await expect(expandedSibling).toBeVisible();

  await cockpit.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('facet-overview')).toBeVisible();
  await cockpit.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Records & History', exact: true }).click();
  await expect(page.getByTestId('facet-records')).toBeVisible();
  await cockpit.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(page.getByTestId('facet-evidence')).toBeVisible();
  const executorEvidence = page.getByTestId('facet-evidence').locator('.evidence-record').filter({ hasText: executor });
  await executorEvidence.getByRole('button', { name: 'Load segment catalog' }).click();
  await executorEvidence.getByRole('link', { name: /Segment 1/ }).click();
  await expect(page).toHaveURL(`/agents/${executor}?segment=1`);
  await expect(expandedSibling).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp('facet=evidence'));
  await page.goForward();
  await expect(page).toHaveURL(`/agents/${executor}?segment=1`);

  await screenshot(page, testInfo, 'cockpit-conversation-1440x900.png');
  expect(rest.unknown).toEqual([]);
});

test('exact entry reload, unavailable card, global scope, narrow controls, and Analyst Back stay truthful', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const rest = await setup(page, true);
  await page.route(`**/api/agents/${encodeURIComponent(executor)}/conversation`, async (route: Route) => {
    const entry = { id: marker, session_id: executor, role: 'assistant', kind: 'text', content: 'Exact marker transcript row', context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true }, round_id: 'r-assistant-99999999999949998999999999999999', message_index: 0, block_index: 0, timestamp: now };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversation', 200, { session_id: executor, segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, segment_context: null, entries: [entry], cursor: { segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, message_id: marker } })) });
  });
  await page.goto(`/agents/${encodeURIComponent(executor)}?entry=${marker}`);
  await expect(page.getByText('Exact marker transcript row')).toBeVisible();
  await expect(page.locator(`[data-entry-id="${marker}"]`)).toHaveClass(/targeted-conversation-entry/);
  await expect(page.getByTestId('cockpit-facet-nav')).toBeVisible();
  await page.reload();
  await expect(page.locator(`[data-entry-id="${marker}"]`)).toHaveClass(/targeted-conversation-entry/);

  const toolbarButtons = page.locator('.conv-toolbar button');
  await expect(toolbarButtons).toHaveCount(0);
  await expect(page.locator('.technical-details > summary')).toBeVisible();
  for (const button of await toolbarButtons.all()) await expect(button).toBeVisible();
  const toolbarFitsReader = await page.locator('.focused-reader').evaluate((reader) => {
    const boundary = reader.getBoundingClientRect();
    return [...reader.querySelectorAll<HTMLElement>('.conv-toolbar button')].every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= boundary.left && rect.right <= boundary.right && rect.top >= boundary.top && rect.bottom <= boundary.bottom;
    });
  });
  expect(toolbarFitsReader).toBe(true);
  await expect(page.getByTestId('back-to-card')).toHaveCount(0);
  await screenshot(page, testInfo, 'cockpit-conversation-900x700.png');

  await page.goto(`/agents/${encodeURIComponent(executor)}?entry=88888888-8888-4888-8888-888888888888`);
  await expect(page.getByText('The requested conversation entry was not found in the current segment.')).toBeVisible();

  await page.route(`**/api/cards/${smokeCardId}`, async (route: Route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Card not found', cardId: smokeCardId }) });
  });
  await page.goto(`/agents/${encodeURIComponent(executor)}`);
  await expect(page.getByTestId('card-flow-unavailable')).toHaveText('Card flow unavailable');
  await expect(page.locator('.conversation-container')).toHaveCount(1);
  await expect(page.getByTestId('cockpit-facet-nav').locator('[aria-disabled="true"]')).toHaveCount(3);

  await page.goto('/agents/agent:oversight:global');
  await expect(page.getByTestId('session-global-header')).toContainText('Global session');
  await expect(page.getByTestId('cockpit-facet-nav')).toHaveCount(0);
  await expect(page.locator('.conversation-container')).toHaveCount(1);

  await page.unroute(`**/api/cards/${smokeCardId}`);
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link').filter({ hasText: 'Files' }).click();
  await expect(page).toHaveURL('/files');
  await page.getByTestId('strip-current-work').getByRole('link').click();
  await expect(page).toHaveURL(`/cards/${smokeCardId}`);
  await page.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Conversations', exact: true }).click();
  await expect(page).toHaveURL(`/agents/${executor}`);
  await page.getByRole('button', { name: new RegExp(reviewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  await sendAnalyst(page, 'Back one');
  await expect(page).toHaveURL(`/agents/${executor}`);
  await sendAnalyst(page, 'Back two');
  await expect(page).toHaveURL(`/cards/${smokeCardId}`);
  await sendAnalyst(page, 'Back three');
  await expect(page).toHaveURL('/files');
  expect(rest.unknown).toEqual([]);
});

for (const sessionId of [executor, 'agent:oversight:global']) {
  test(`real marker-only exact navigation, reload, Back and current updates: ${sessionId}`, async ({ page }, testInfo) => {
    const rest = await setup(page);
    const global = sessionId.endsWith(':global');
    const first = activationRow(sessionId, global ? '11111111-1111-4111-8111-111111111111' : '0123456789abcdef');
    const second = activationRow(sessionId, global ? '22222222-2222-4222-8222-222222222222' : 'fedcba9876543210');
    let currentReads = 0;
    let updated = false;
    await page.route('**/api/agents/*/conversation**', async (route) => {
      const url = new URL(route.request().url());
      const id = decodeURIComponent(url.pathname.split('/')[3]!);
      if (id !== sessionId) return route.fallback();
      const version = url.pathname.endsWith('/versions/1') ? 1 : url.pathname.endsWith('/versions/2') ? 2 : null;
      if (version) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversationVersions.get', 200, {
        session_id: id, version, entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', published_at: now,
        segment_context: version === 1 ? null : retainedInstructionContext(id), entries: [version === 1 ? first : second],
      })) });
      if (url.pathname.endsWith('/versions')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversationVersions.list', 200, {
        session_id: id, versions: [
          { entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, published_at: now, genesis_kind: 'ordinary', source_version: null },
          { entry_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 2, published_at: now, genesis_kind: 'compacted', source_version: 1 },
        ], total: 2,
      })) });
      currentReads++;
      const row = updated ? second : first;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversation', 200, {
        session_id: id, segment_id: updated ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111', segment_version: updated ? 2 : 1, segment_context: updated ? retainedInstructionContext(id) : null, entries: [row], cursor: { segment_id: updated ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111', segment_version: updated ? 2 : 1, message_id: row.id },
      })) });
    });
    const target = () => page.locator('.conv-rounds .targeted-conversation-entry');
    if (!global) {
      await page.goto(`/cards/${smokeCardId}`);
      const tab = page.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Conversations', exact: true });
      await tab.focus();
      await tab.press('Enter');
      await expect(page).toHaveURL(`/agents/${sessionId}`);
      await expect(page.getByTestId('activation-index')).toContainText('Activation entry recorded');
      await page.getByTestId('activation-index').locator(':scope > summary').click();
      await expect(page.locator('.conv-rounds [data-entry-id]')).toHaveAttribute('data-entry-id', first.id);
      const open = page.getByRole('link', { name: 'Open entry', exact: true });
      await open.focus();
      await open.press('Enter');
    } else {
      await page.goto(`/agents/${encodeURIComponent(sessionId)}?segment=1&entry=${encodeURIComponent(first.id)}`);
      await expect(page.getByTestId('session-global-header')).toContainText('Global session');
    }
    await expect(target()).toHaveAttribute('data-entry-id', first.id);
    await expect(target()).toBeFocused();
    expect(new URL(page.url()).searchParams.get('entry')).toBe(first.id);
    await page.reload();
    await expect(target()).toHaveAttribute('data-entry-id', first.id);
    const segment2 = page.getByRole('button', { name: /Segment 2/ });
    await segment2.focus();
    await segment2.press('Enter');
    const open = page.getByRole('link', { name: 'Open entry', exact: true });
    await page.getByTestId('activation-index').locator(':scope > summary').click();
    await open.focus();
    await open.press('Enter');
    await expect(target()).toHaveAttribute('data-entry-id', second.id);
    const reads = currentReads;
    updated = true;
    await page.evaluate((id) => {
      window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_id: '22222222-2222-4222-8222-222222222222', segment_version: 2, visible_message_id: 'new-current-marker' });
    }, sessionId);
    await expect.poll(() => currentReads).toBeGreaterThan(reads);
    await expect(target()).toHaveAttribute('data-entry-id', second.id);
    await expect(page.getByTestId('activation-index')).toContainText('segment 2 (exact selection)');
    await page.goBack(); // segment 2 without entry
    await page.goBack(); // exact segment 1 marker
    await expect(target()).toHaveAttribute('data-entry-id', first.id);
    expect(new URL(page.url()).searchParams.get('entry')).toBe(first.id);
    await screenshot(page, testInfo, `activation-${global ? 'global' : 'card'}-exact.png`);
    expect(rest.unknown).toEqual([]);
  });
}

test('exact call and result rows retain focus through direct/reload/change/Back and fail closed', async ({ page }, testInfo) => {
  const rest = await setup(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const opaqueSource = ' opaque "[] # % grouped call ';
  const opaque = `22222222-2222-4222-8222-222222222222:tool-call:${opaqueSource}`;
  const standalone = '11111111-1111-4111-8111-111111111111:tool-call:synthetic-standalone-call';
  const entries = [
    ...callRows('synthetic-standalone-call', 'r-assistant-11111111111141118111111111111111', 1, 'custom_probe'),
    ...callRows('group-first', 'r-assistant-22222222222242228222222222222222', 2),
    ...callRows(opaqueSource, 'r-assistant-22222222222242228222222222222222', 3),
    ...callRows('unrelated-first', 'r-assistant-33333333333343338333333333333333', 4),
    ...callRows('unrelated-second', 'r-assistant-33333333333343338333333333333333', 5),
  ];
  let exactReads = 0;
  let currentReads = 0;
  await page.route('**/api/agents/*/conversation**', async (route) => {
    const url = new URL(route.request().url());
    if (decodeURIComponent(url.pathname.split('/')[3]!) !== executor) return route.fallback();
    if (url.pathname.endsWith('/versions/1')) {
      exactReads++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversationVersions.get', 200, {
        session_id: executor, version: 1, entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', published_at: now, segment_context: null, entries,
      })) });
    }
    if (url.pathname.endsWith('/versions')) return route.fallback();
    currentReads++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversation', 200, {
      session_id: executor, segment_id: '22222222-2222-4222-8222-222222222222', segment_version: 2, segment_context: null, entries: [], cursor: { segment_id: '22222222-2222-4222-8222-222222222222', segment_version: 2, message_id: null },
    })) });
  });
  const link = (entry: string, segment = '1') => `/agents/${encodeURIComponent(executor)}?segment=${segment}&entry=${encodeURIComponent(entry)}`;
  const chip = () => page.locator('.tool-chip .targeted-conversation-entry');
  const assertTarget = async (entry: string) => {
    await expect(chip()).toHaveAttribute('data-entry-id', entry);
    await expect(chip()).toBeVisible();
    await expect(chip()).toBeFocused();
    await expect(page.getByText(/requested conversation entry was not found/)).toHaveCount(0);
    await expect(chip().locator('h4').first()).toHaveText(entry.includes(':tool-result:') ? 'Result' : 'Request');
  };
  await page.goto(link(opaque));
  await assertTarget(opaque);
  await expect(page.locator('.tool-chip')).toHaveCount(5);
  await expect(page.locator('.tool-group-toggle')).toHaveCount(0);
  await page.reload();
  await assertTarget(opaque);
  await page.goto(link(standalone));
  await assertTarget(standalone);
  await expect(page.locator('.tool-group-body')).toHaveCount(0);
  await page.goBack();
  await assertTarget(opaque);
  await expect(page.locator('.tool-chip')).toHaveCount(5);
  const reads = currentReads;
  await page.evaluate((id) => window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_id: '22222222-2222-4222-8222-222222222222', segment_version: 2, visible_message_id: 'background-update' }), executor);
  await expect.poll(() => currentReads).toBeGreaterThan(reads);
  await assertTarget(opaque);
  await screenshot(page, testInfo, 'exact-call-focused.png');
  const resultId = `22222222-2222-4222-8222-222222222222:tool-result:${opaqueSource}`;
  await page.goto(link(resultId));
  await assertTarget(resultId);
  const acceptedReads = exactReads;
  for (const segment of ['0', 'bad', '1.5', '9007199254740992']) {
    await page.goto(link(opaque, segment));
    await expect(page.getByText('Invalid segment selection')).toBeVisible();
    await expect(page.locator('.tool-chip, .tool-group-body')).toHaveCount(0);
    await expect(page.getByText(/requested conversation entry was not found/)).toHaveCount(0);
  }
  expect(exactReads).toBe(acceptedReads);
  expect(errors).toEqual([]);
  expect(rest.unknown).toEqual([]);
});

test('System Events shows scheduled restart evidence without replacement readiness', async ({ page }, testInfo) => {
  const rest = await setup(page);
  await page.route('**/api/events?**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('events.list', 200, {
    events: [{ id: '11111111-1111-4111-8111-111111111111', timestamp: now, kind: 'operator_runtime_control', actor: 'operator', surface: 'operator_api', result: { operation: 'restart_server', outcome: 'restart_scheduled' } }], total: 1,
  })) }));
  await page.goto('/system');
  const events = page.getByRole('button', { name: 'Events', exact: true });
  await events.focus();
  await events.press('Enter');
  await expect(page.locator('.events-summary')).toHaveText('Restart scheduled — shutdown and replacement readiness not established');
  await expect(page.locator('.events-panel')).toContainText('pre-handler denials, thrown failures and transport loss have no promised row');
  await screenshot(page, testInfo, 'runtime-control-event.png');
  expect(rest.unknown).toEqual([]);
});

test('diagnostic exact targets open at source position and retain truth through refresh and Back', async ({ page }, testInfo) => {
  const rest = await setup(page);
  const pair = callRows('diagnostic-pair', 'r-assistant-33333333333343338333333333333333', 0);
  const base = { session_id: executor, role: 'system', round_id: pair[0]!.round_id, message_index: 1, block_index: 0, timestamp: now };
  const diagnostics = [
    { ...base, id: 'issue-row', kind: 'model_issue', content: `Provider request rejected. ${'Technical error '.repeat(100)}FINAL-ISSUE-Z`, context_policy: { kind: 'structural', behavior: 'provider_failure' } },
    { ...base, id: 'repair-row', role: 'user', kind: 'model_repair', content: 'Return a valid required result. FINAL-DIRECTIVE-Z', context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true } },
    { ...base, id: 'recovery-row', kind: 'model_recovered', content: MODEL_RECOVERY_NOTICE_TEXT, context_policy: { kind: 'structural', behavior: 'model_recovery_notice' } },
  ];
  let reads = 0;
  await page.route('**/api/agents/*/conversation**', async route => {
    const url = new URL(route.request().url());
    if (decodeURIComponent(url.pathname.split('/')[3]!) !== executor || url.pathname.endsWith('/versions')) return route.fallback();
    reads++;
    const entries = url.searchParams.has('since') ? [] : [pair[0]!, ...diagnostics, pair[1]!];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversation', 200, { session_id: executor, segment_id: '33333333-3333-4333-8333-333333333333', segment_version: 1, segment_context: null, entries, cursor: { segment_id: '33333333-3333-4333-8333-333333333333', segment_version: 1, message_id: pair[1]!.id } })) });
  });
  await page.goto(`/agents/${executor}`);
  const owner = page.locator('.conversation-reading-surface');
  await expect(owner.locator('.diagnostic-row')).toHaveCount(3);
  await expect(owner.locator('.diagnostic-row[open]')).toHaveCount(0);
  await expect(owner.locator('[data-entry-id="repair-row"] > details > summary')).toHaveText('Repair instruction recorded');
  await expect(owner.locator('[data-entry-id="recovery-row"] > details > summary')).toHaveText('Interrupted activation · effects uncertain');
  await owner.locator('.tool-chip-toggle').focus();
  for (const id of ['issue-row', 'repair-row', 'recovery-row']) {
    await page.keyboard.press('Tab');
    const diagnostic = owner.locator(`[data-entry-id="${id}"]`);
    const disclosure = diagnostic.locator(':scope > details');
    const summary = disclosure.locator(':scope > summary');
    await expect(summary).toBeFocused();
    expect(await summary.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid' && parseFloat(getComputedStyle(el).outlineWidth) >= 2)).toBe(true);
    await expect(diagnostic).toHaveAttribute('tabindex', '-1');
    await expect(disclosure).not.toHaveAttribute('open', '');
    await summary.press('Enter');
    await expect(disclosure).toHaveAttribute('open', '');
    await summary.press('Enter');
    await expect(disclosure).not.toHaveAttribute('open', '');
  }
  await page.screenshot({ path: testInfo.outputPath('diagnostics-closed.png') });
  await page.goto(`/agents/${executor}?entry=issue-row`);
  const issue = owner.locator('[data-entry-id="issue-row"]');
  await expect(issue).toBeFocused(); await expect(issue.locator(':scope > details')).toHaveAttribute('open', '');
  await expect(issue.locator('pre')).toHaveText(diagnostics[0]!.content);
  const prior = reads;
  await page.evaluate(id => window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_id: '33333333-3333-4333-8333-333333333333', segment_version: 1, visible_message_id: 'refresh-observation' }), executor);
  await expect.poll(() => reads).toBeGreaterThan(prior);
  await expect(issue.locator(':scope > details')).toHaveAttribute('open', '');
  await page.goto(`/agents/${executor}?entry=recovery-row`);
  await expect(owner.locator('[data-entry-id="recovery-row"]')).toBeFocused();
  await page.goBack(); await expect(issue).toBeFocused();
  await page.reload(); await expect(issue).toBeFocused();
  expect(await owner.evaluate(el => [...el.querySelectorAll<HTMLElement>('*')].filter(child => ['auto', 'scroll'].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1).length)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('diagnostics-expanded.png') });
  expect(rest.unknown).toEqual([]);
});
