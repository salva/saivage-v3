import { test, expect, type Page, type Locator } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { createInstructionFlow, instructionFlowToken } from '../../helpers/conversation-instruction-flows.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';

// Source acceptance: all history comes from compiled classic-typed actors and
// scripted in-process provider turns. No authored markers, mocked API or browser
// submission. The helper contains execution before starting the real read app.
test.describe.configure({ timeout: 120_000, retries: 0 });
type Flow = Awaited<ReturnType<typeof createInstructionFlow>>;
type Session = Flow['sessions'][number];

function readOnlyBrowser(page: Page, flow: Flow) {
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())
      && !(request.method() === 'POST' && url.pathname === '/api/auth/ws-ticket')) {
      mutations.push(`${request.method()} ${url.pathname}`);
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  return () => {
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
    expect(flow.unexpectedProviderRequests).toEqual([]);
    expect(flow.callbackCount()).toBe(flow.settledCallbackCount);
  };
}

async function inspect(page: Page, flow: Flow, source: Session, historical = false, navigate = true) {
  const path = `/api/agents/${encodeURIComponent(source.session)}/conversation${historical ? '/versions/1' : ''}`;
  const response = await page.request.get(`${flow.origin}${path}`, { headers: { authorization: `Bearer ${instructionFlowToken}` }, timeout: 10_000 });
  expect(response.status()).toBe(200);
  const dto = historical
    ? parseOperatorResponse('agents.conversationVersions.get', 200, await response.json())
    : parseOperatorResponse('agents.conversation', 200, await response.json());
  // Compare the real public API against canonical source IDs/provenance. Text
  // expectations are the existing privacy-filtered projection, never raw private
  // input bodies. Preparation values were separately checked against provider input.
  expect(dto.entries.slice(0, source.publicRows.length)).toEqual(source.publicRows);
  if (navigate) await page.goto(`${flow.origin}/agents/${source.session}${historical ? '?segment=1' : ''}`);
  const timeline = page.locator('.conversation-container .conversation-timeline');
  await expect(timeline.locator('.activation-marker')).toHaveCount(source.activations.length);
  expect(await timeline.locator('.activation-marker').evaluateAll(elements => elements.map(element => element.getAttribute('data-entry-id'))))
    .toEqual(source.activations.map(start => start.markerId));
  for (const toggle of await timeline.locator('.tool-chip-toggle').all()) await toggle.click();
  for (const start of source.activations) {
    const marker = timeline.locator(`[data-entry-id="${start.markerId}"]`);
    await expect(marker).toContainText('Prepared instructions');
    await expect(marker).toContainText('not proof of model delivery or interpretation');
    const role = marker.locator('.instruction-disclosure').first();
    await role.locator('summary').click();
    await expect(role.locator('pre')).toHaveText(start.role);
    expect(start.role).toContain(start.contract);
    const node = marker.locator('.instruction-disclosure').filter({ has: page.locator('summary', { hasText: `Node ${start.node} instructions` }) });
    await expect(node.locator('summary')).toHaveText(`Node ${start.node} instructions`);
    await node.locator('summary').click();
    await expect(node.locator('pre')).toHaveText(start.nodeText);
    // Routine turn-start/end activity is intentionally not painted. All ordinary
    // text, correction and tool events retain source anchors after the marker.
    const visibleIds = source.rows.filter(row => start.rowIds.includes(row.id) && row.kind !== 'activity').map(row => row.id);
    for (const id of visibleIds) {
      await expect(timeline.locator(`[data-entry-id="${id}"]`)).toHaveCount(1);
      expect(await timeline.evaluate((element, ids) => {
        const first = element.querySelector(`[data-entry-id="${ids[0]}"]`)!;
        const second = element.querySelector(`[data-entry-id="${ids[1]}"]`)!;
        return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
      }, [start.markerId, id])).toBe(true);
    }
    const next = source.activations[source.activations.indexOf(start) + 1];
    await sourceOrder(timeline, [start.markerId, ...visibleIds, ...(next ? [next.markerId] : [])]);
  }
  for (const row of source.publicRows.filter(row => row.instruction_origin === 'workflow_prompt')) {
    const band = timeline.locator(`[data-entry-id="${row.id}"]`);
    await expect(band).toContainText('Recorded workflow instruction');
    if (row.kind === 'model_repair') await expect(band.locator('.diagnostic-row.instruction-origin')).toHaveCount(1);
    else await expect(band.locator('.instruction-disclosure')).toHaveCount(1);
    await expect(band.locator('pre')).toHaveText(row.content);
  }
  expect(await timeline.textContent()).not.toContain('Delivered instructions');
  return { dto, timeline };
}

async function sourceOrder(timeline: Locator, ids: string[]) {
  // Source coordinates/IDs, not timestamp or label sorting. Expanded tool-result
  // anchors can live inside their owning chip, so compare exact DOM positions.
  for (let index = 1; index < ids.length; index += 1) {
    expect(await timeline.evaluate((element, pair) => {
      const earlier = element.querySelector(`[data-entry-id="${pair[0]}"]`)!;
      const later = element.querySelector(`[data-entry-id="${pair[1]}"]`)!;
      return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, [ids[index - 1]!, ids[index]!])).toBe(true);
  }
}

test('A: actual Executor red → green → green → refactor keeps four boundaries through corrections and ordinary continuations', async ({ page }) => {
  const flow = await createInstructionFlow('code');
  try {
    const guard = readOnlyBrowser(page, flow);
    await seedTokenBeforeNavigation(page, instructionFlowToken);
    expect(flow.childCalls).toBe(10);
    expect(flow.calls.map(call => call.ordinal)).toEqual([0, 0, 0, 0, 1, 1, 2, 2, 3, 3]);
    const source = flow.sessions[0]!;
    expect(flow.sessions).toHaveLength(1);
    expect(source.session).toBe(`agent:executor:${flow.childId}`);
    expect(source.activations.map(start => start.ordinal)).toEqual([0, 1, 2, 3]);
    expect(source.activations.map(start => start.node)).toEqual(['red', 'green', 'green', 'refactor']);
    expect(new Set(source.activations.map(start => start.markerId)).size).toBe(4);
    expect(new Set(flow.calls.map(call => call.inputId)).size).toBe(10);
    expect(source.activations[1]!.nodeText).toBe(source.activations[2]!.nodeText);
    const repairs = source.rows.filter(row => row.instruction_origin === 'workflow_prompt' && ['model_repair', 'text'].includes(row.kind));
    const correction = repairs.find(row => row.kind === 'model_repair')!;
    expect(correction).toBeDefined();
    expect(repairs.filter(row => row.content === correction.content).map(row => row.kind)).toEqual(['model_repair', 'text']);
    expect(source.rows.filter(row => row.kind === 'text' && row.content.includes('attempts remaining')).every(row => !row.instruction_origin)).toBe(true);
    const { timeline } = await inspect(page, flow, source);
    await sourceOrder(timeline, source.activations.map(start => start.markerId));
    // Exact source ordering through both correction paths, then status tool turns.
    const firstRows = source.rows.filter(row => source.activations[0]!.rowIds.includes(row.id) && (row.kind !== 'activity' || row.id === source.activations[0]!.markerId));
    await sourceOrder(timeline, firstRows.map(row => row.id));
    const historical = await inspect(page, flow, source, true);
    await sourceOrder(historical.timeline, source.activations.map(start => start.markerId));
    await page.reload();
    await expect(page.locator('.conversation-timeline .activation-marker')).toHaveCount(4);
    for (const start of source.activations) {
      const marker = page.locator(`.conversation-timeline [data-entry-id="${start.markerId}"]`);
      await marker.locator('.instruction-disclosure').first().locator('summary').click();
      await expect(marker.locator('.instruction-disclosure').first().locator('pre')).toHaveText(start.role);
      const node = marker.locator('.instruction-disclosure').filter({ has: page.locator('summary', { hasText: `Node ${start.node} instructions` }) });
      await node.locator('summary').click();
      await expect(node.locator('pre')).toHaveText(start.nodeText);
    }
    guard();
  } finally { await flow.cleanup(); }
});

test('B: actual Executor → Reviewer handoff keeps once-only target preludes, edge instructions and accepted record anchors', async ({ page }) => {
  const flow = await createInstructionFlow('architecture');
  try {
    const guard = readOnlyBrowser(page, flow);
    await seedTokenBeforeNavigation(page, instructionFlowToken);
    expect(flow.childCalls).toBe(6);
    expect(flow.calls.map(call => call.ordinal)).toEqual([0, 0, 1, 1, 2, 2]);
    const executor = flow.sessions.find(source => source.session.includes(':executor:'))!;
    const reviewer = flow.sessions.find(source => source.session.includes(':reviewer:'))!;
    expect(flow.sessions.map(source => source.session)).toEqual([`agent:executor:${flow.childId}`, `agent:reviewer:${flow.childId}`]);
    expect(executor.activations.map(start => start.node)).toEqual(['draft']);
    expect(reviewer.activations.map(start => start.node)).toEqual(['component-review', 'system-review']);
    await inspect(page, flow, executor);
    await page.getByRole('complementary', { name: 'Card participants' }).getByRole('button', { name: new RegExp(reviewer.session) }).click();
    await expect(page).toHaveURL(`${flow.origin}/agents/${reviewer.session}`);
    const { timeline } = await inspect(page, flow, reviewer, false, false);
    await sourceOrder(timeline, reviewer.activations.map(start => start.markerId));
    for (const start of reviewer.activations) {
      const owned = reviewer.rows.filter(row => start.rowIds.includes(row.id));
      const prelude = owned.filter(row => row.content.startsWith('Previous process node:'));
      expect(prelude).toHaveLength(1);
      const context = prelude[0]!;
      expect(context.instruction_origin).toBeUndefined();
      expect(context.content).toContain(start.node === 'component-review' ? 'Summary: Initial draft ready.' : 'Summary: Component scope approved.');
      expect(reviewer.rows.filter(row => row.content === context.content).map(row => row.id)).toEqual([context.id]);
      const index = owned.indexOf(context);
      const edge = owned[index + 1]!;
      expect(edge.instruction_origin).toBe('workflow_prompt');
      expect(reviewer.rows.filter(row => row.content === edge.content).map(row => row.id)).toEqual([edge.id]);
      const continuationCalls = flow.calls.filter(call => call.ordinal === start.ordinal);
      expect(continuationCalls).toHaveLength(2);
      for (const call of continuationCalls) {
        expect(call.contextIds.filter(id => id === context.id)).toEqual([context.id]);
        expect(call.contextIds.filter(id => id === edge.id)).toEqual([edge.id]);
      }
      const output = owned.find(row => row.role === 'assistant')!;
      await sourceOrder(timeline, [start.markerId, context.id, edge.id, output.id]);
      const contextBand = timeline.locator(`[data-entry-id="${context.id}"]`);
      await expect(contextBand).not.toContainText('Recorded workflow instruction');
      await expect(contextBand.locator('.instruction-disclosure')).toHaveCount(0);
      await expect(timeline.locator(`[data-entry-id="${edge.id}"]`)).toContainText('Recorded workflow instruction');
      const recordUrls = context.content.match(/record:\/\/\/(?:status|review)\.md\?card=[^\s]+&v=\d+/gu)!;
      expect(recordUrls.length).toBeGreaterThan(0);
      // Generated plain record URLs are preserved text, not fabricated Markdown
      // links. Their owning context row is the exact navigable source anchor.
      for (const url of recordUrls) {
        await expect(contextBand).toContainText(url);
        const record = new URL(url);
        const name = record.pathname.slice(1);
        const version = record.searchParams.get('v')!;
        const response = await page.request.get(`${flow.origin}/api/cards/${flow.childId}/records/${name}/versions/${version}`, { headers: { authorization: `Bearer ${instructionFlowToken}` }, timeout: 10_000 });
        expect(response.status()).toBe(200);
      }
    }
    await inspect(page, flow, executor, true);
    expect(await page.locator('.conversation-timeline').textContent()).not.toContain('Node component-review instructions');
    expect(await page.locator('.conversation-timeline').textContent()).not.toContain('Node system-review instructions');
    await inspect(page, flow, reviewer, true);
    expect(await page.locator('.conversation-timeline').textContent()).not.toContain('Node draft instructions');
    guard();
  } finally { await flow.cleanup(); }
});

for (const scene of ['cancelled', 'failed'] as const) {
  test(`C: actual ${scene} provider turn retains honest prepared-not-delivered instructions`, async ({ page }) => {
    const flow = await createInstructionFlow(scene);
    try {
      const guard = readOnlyBrowser(page, flow);
      await seedTokenBeforeNavigation(page, instructionFlowToken);
      expect(flow.childCalls).toBe(1);
      expect(flow.cancellationObserved).toBe(scene === 'cancelled');
      expect(flow.classifiedFailureObserved).toBe(scene === 'failed');
      const source = flow.sessions[0]!;
      expect(source.activations.map(start => start.node)).toEqual(['red']);
      expect(source.activations.map(start => start.inputId)).toEqual(flow.calls.map(call => call.inputId));
      const canonical = readConversation(flow.root, source.session).physicalRows;
      if (scene === 'failed') {
        expect(flow.containedLifecycle).toMatchObject({ status: 'failed', result: { kind: 'runtime-failure', summary: 'Synthetic permanent provider authentication failure' }, error: 'Synthetic permanent provider authentication failure' });
        const response = await page.request.get(`${flow.origin}/api/cards/${flow.childId}`, { headers: { authorization: `Bearer ${instructionFlowToken}` }, timeout: 10_000 });
        expect(response.status()).toBe(200);
        expect(parseOperatorResponse('cards.get', 200, await response.json()).card.lifecycle).toEqual(flow.containedLifecycle);
        await page.goto(`${flow.origin}/cards/${flow.childId}`);
        await expect(page.getByText('Reported card error', { exact: true })).toBeVisible();
        await expect(page.getByTestId('overview-problems')).toContainText('Synthetic permanent provider authentication failure');
      } else {
        // Ordinary read-app startup owns recovery of the contained durable chain;
        // the test never appends interruption notices or corrective rows itself.
        expect(flow.containedLifecycle.status).toBe('running');
        expect(flow.readLifecycle.status).toBe('stopped');
        expect(canonical.filter(row => row.kind === 'model_recovered')).toHaveLength(1);
        expect(canonical.find(row => row.kind === 'model_recovered')!.content).toContain('External or domain effects may or may not have happened.');
        expect(canonical.filter(row => ['tool_call', 'tool_result', 'text'].includes(row.kind) && row.role === 'assistant')).toEqual([]);
      }
      const { timeline } = await inspect(page, flow, source, true);
      if (scene === 'cancelled') {
        const recovery = canonical.find(row => row.kind === 'model_recovered')!;
        const diagnostic = timeline.locator(`[data-entry-id="${recovery.id}"]`);
        await expect(diagnostic).toContainText('Interrupted activation · effects uncertain');
        await diagnostic.locator('summary').click();
        await expect(diagnostic.locator('pre')).toHaveText(recovery.content);
      }
      expect(await timeline.textContent()).not.toMatch(/Delivered instructions|delivery confirmed/i);
      guard();
    } finally { await flow.cleanup(); }
  });
}
