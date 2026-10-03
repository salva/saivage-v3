import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeCardId, retainedInstructionContext } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';
import { toolRowPolicies } from '../../helpers/row-policy-fixtures.js';

const token = 'synthetic-cockpit-conversation-token';
const executor = `agent:executor:${smokeCardId}`;
const reviewer = `agent:reviewer:${smokeCardId}`;
const marker = '99999999-9999-4999-8999-999999999999';
const now = '2026-09-28T12:00:00.000Z';

function activationRow(sessionId: string, suffix: string) {
  return { id: `${sessionId}:activation:${suffix}`, session_id: sessionId, role: 'system', kind: 'activity',
    content: JSON.stringify({ event: 'activation_open', agent_name: sessionId.split(':')[1], ...(sessionId.endsWith(':global') ? {} : { card_id: smokeCardId }), input_id: '11111111-1111-4111-8111-111111111111', timestamp: now }),
    context_policy: { kind: 'structural', behavior: 'activation_boundary' }, round_id: 'r-pre-11111111111141118111111111111111', message_index: 0, block_index: 0, timestamp: now };
}

function callRows(id: string, round: string, index: number, tool = 'read') {
  const resultContent = JSON.stringify({ success: true, data: { content: 'synthetic-raw-response-only' } });
  const policies = toolRowPolicies({ content: resultContent });
  const source = round.slice('r-assistant-'.length).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  const base = { session_id: executor, tool, tool_call_id: id, round_id: round, message_index: index, block_index: 0, timestamp: now };
  return [
    { ...base, id: `${source}:tool-call:${id}`, role: 'assistant', kind: 'tool_call', context_policy: policies.call, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: base.tool_call_id, type: 'function', function: { name: tool, arguments: JSON.stringify({ path: 'README.md', synthetic: 'raw-request-only' }) } }] }) },
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('agents.conversation', 200, { session_id: executor, segment_version: 1, segment_context: null, entries: [entry], cursor: { segment_version: 1, message_id: marker } })) });
  });
  await page.goto(`/agents/${encodeURIComponent(executor)}?entry=${marker}`);
  await expect(page.getByText('Exact marker transcript row')).toBeVisible();
  await expect(page.locator(`[data-entry-id="${marker}"]`)).toHaveClass(/targeted-conversation-entry/);
  await expect(page.getByTestId('cockpit-facet-nav')).toBeVisible();
  await page.reload();
  await expect(page.locator(`[data-entry-id="${marker}"]`)).toHaveClass(/targeted-conversation-entry/);

  const toolbarButtons = page.locator('.conv-toolbar button');
  await expect(toolbarButtons).toHaveCount(3);
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
        session_id: id, segment_version: updated ? 2 : 1, segment_context: updated ? retainedInstructionContext(id) : null, entries: [row], cursor: { segment_version: updated ? 2 : 1, message_id: row.id },
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
    await open.focus();
    await open.press('Enter');
    await expect(target()).toHaveAttribute('data-entry-id', second.id);
    const reads = currentReads;
    updated = true;
    await page.evaluate((id) => {
      window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_version: 2, visible_message_id: 'new-current-marker' });
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

test('exact call chips reveal only their group, retain focus through direct/reload/change/Back, and fail closed', async ({ page }, testInfo) => {
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
      session_id: executor, segment_version: 2, segment_context: null, entries: [], cursor: { segment_version: 2, message_id: null },
    })) });
  });
  const link = (entry: string, segment = '1') => `/agents/${encodeURIComponent(executor)}?segment=${segment}&entry=${encodeURIComponent(entry)}`;
  const chip = () => page.locator('.tool-chip.targeted-conversation-entry');
  const assertTarget = async (entry: string) => {
    await expect(chip()).toHaveAttribute('data-entry-id', entry);
    await expect(chip()).toBeVisible();
    await expect(chip()).toBeFocused();
    await expect(page.getByText(/requested conversation entry was not found/)).toHaveCount(0);
    await expect(page.locator('.tool-chip-detail, .tool-chip-raw')).toHaveCount(0);
    await expect(page.getByText('synthetic-raw-response-only', { exact: false })).toHaveCount(0);
  };
  await page.goto(link(opaque));
  await assertTarget(opaque);
  await expect(page.locator('.tool-group-body')).toHaveCount(1);
  await expect(page.locator('.tool-group-toggle').nth(1)).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await assertTarget(opaque);
  await page.goto(link(standalone));
  await assertTarget(standalone);
  await expect(page.locator('.tool-group-body')).toHaveCount(0);
  await page.goBack();
  await assertTarget(opaque);
  await expect(page.locator('.tool-group-body')).toHaveCount(1);
  const reads = currentReads;
  await page.evaluate((id) => window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id, segment_version: 2, visible_message_id: 'background-update' }), executor);
  await expect.poll(() => currentReads).toBeGreaterThan(reads);
  await assertTarget(opaque);
  await screenshot(page, testInfo, 'exact-grouped-call-focused.png');
  await page.goto(link(`22222222-2222-4222-8222-222222222222:tool-result:${opaqueSource}`));
  await expect(page.getByText('The requested conversation entry was not found in the selected exact segment.')).toBeVisible();
  await expect(chip()).toHaveCount(0);
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
