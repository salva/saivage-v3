import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeCardId, smokeServerAvailability } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const token = 'synthetic-overview-clarity-token';
const now = '2026-09-28T12:00:00.000Z';
const sessionId = `agent:executor:${smokeCardId}`;
const objectiveName = 'mission-custom.md';
const extraNames = ['constraints.md', 'source-notes.md', 'review-custom.md'] as const;
const longTailMarker = 'OBJECTIVE-FULL-CONTENT-LAST-MARKER';
const transcriptLastMarker = 'TRANSCRIPT-LAST-MESSAGE-MARKER';
const graphLastMarker = 'final-custom-record-with-a-very-long-name.md';
const longCardTitle = `Clarify the cockpit overview while preserving an unusually long selected-card title ${'across constrained contextual conversation navigation '.repeat(7)}`.trim();

const objective = [
  '# Custom objective',
  '',
  'Make the operator overview explain the real work before implementation mechanics, while preserving exact source material.',
  `A deliberately long unbroken address must wrap without widening the cockpit: https://example.invalid/${'source-segment-'.repeat(65)}`,
  'This paragraph makes the source exceed the bounded excerpt. '.repeat(20),
  longTailMarker,
].join('\n');

const contents: Record<string, string> = {
  [objectiveName]: objective,
  'constraints.md': '# Constraints\n\nThese are neutral source constraints, not a progress report.\n\n' + 'Keep factual source wording. '.repeat(35),
  'source-notes.md': '# Source notes\n\nReference material with no inferred completion meaning.\n\n' + 'https://example.invalid/' + 'very-long-source-token-'.repeat(45),
  'review-custom.md': '# Custom observations\n\nSubstantive neutral prose; the generic name does not imply approval.',
};

const descriptors = [
  { name: objectiveName, format: 'markdown' as const, schema: 'mission.v1', bootstrap: true, current: { head_id:'11111111-1111-4111-8111-111111111111', revision: 5, current_url: `record:///${objectiveName}?card=${smokeCardId}`, accepted_version_url: `record:///${objectiveName}?card=${smokeCardId}&v=2`, state: 'open' as const, accepted_source_version: 2, draft_present: true } },
  { name: 'constraints.md', format: 'markdown' as const, schema: 'plain.v1', bootstrap: false, current: { head_id:'11111111-1111-4111-8111-111111111111', revision: 3, current_url: `record:///constraints.md?card=${smokeCardId}`, accepted_version_url: `record:///constraints.md?card=${smokeCardId}&v=2`, state: 'closed' as const, accepted_source_version: 2, draft_present: false } },
  { name: 'source-notes.md', format: 'markdown' as const, schema: 'plain.v1', bootstrap: false, current: { head_id:'11111111-1111-4111-8111-111111111111', revision: 4, current_url: `record:///source-notes.md?card=${smokeCardId}`, accepted_version_url: `record:///source-notes.md?card=${smokeCardId}&v=4`, state: 'closed' as const, accepted_source_version: 4, draft_present: false } },
  { name: 'review-custom.md', format: 'markdown' as const, schema: 'plain.v1', bootstrap: false, current: { head_id:'11111111-1111-4111-8111-111111111111', revision: 1, current_url: `record:///review-custom.md?card=${smokeCardId}`, accepted_version_url: `record:///review-custom.md?card=${smokeCardId}&v=1`, state: 'closed' as const, accepted_source_version: 1, draft_present: false } },
];

const card = {
  head_id:'11111111-1111-4111-8111-111111111111',
  id: smokeCardId,
  type: 'code',
  title: longCardTitle,
  lifecycle: {
    status: 'failed',
    result: { kind: 'workflow-result', terminal: 'FAILED', agent_name: 'executor', node_id: 'node-01', outcome: 'execution:failed', summary: 'The source refresh failed after retaining the last useful observation.', records: [{ name: 'constraints.md', url: `record:///constraints.md?card=${smokeCardId}&v=2`, version: 2 }] },
    error: 'Synthetic blocked source: upstream evidence could not be refreshed.',
    completed_at: now,
  },
  urgency: 'normal', created_at: now, updated_at: now, allowedActions: [], version_seq: 9,
};

const railSessions = [
  { id: sessionId, agent_name: 'executor', session_scope: 'card', card_id: smokeCardId, started_at: now, status: 'active', activity: 'busy', compaction: null },
  ...Array.from({ length: 18 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, '0');
    const agentName = `fixture-worker-${suffix}`;
    return { id: `agent:${agentName}:${smokeCardId}`, agent_name: agentName, session_scope: 'card', card_id: smokeCardId, started_at: now, status: 'inactive', activity: 'idle', compaction: null };
  }),
] as const;

function acceptedRecord(name: string, content: string, version: number) {
  return parseOperatorResponse('cards.records.get', 200, {
    card_id: smokeCardId,
    record: {
      head_id:'11111111-1111-4111-8111-111111111111', name, revision: version, current_url: `record:///${name}?card=${smokeCardId}`, accepted_version_url: `record:///${name}?card=${smokeCardId}&v=${version}`, state: 'closed',
      accepted: { source_version: version, source_entry_id: '55555555-5555-4555-8555-555555555555', committed_at: now, writer_agent: 'executor', card_version_seq: 8, card_history_version: 8, card_history_entry_id: '11111111-1111-4111-8111-111111111111', content, content_sha256: 'a'.repeat(64), size_bytes: content.length },
      draft: null, effective_content_source: 'accepted',
    },
  });
}

function objectiveRecord() {
  return parseOperatorResponse('cards.records.get', 200, {
    card_id: smokeCardId,
    record: {
      head_id:'11111111-1111-4111-8111-111111111111', name: objectiveName, revision: 5, current_url: `record:///${objectiveName}?card=${smokeCardId}`, accepted_version_url: `record:///${objectiveName}?card=${smokeCardId}&v=2`, state: 'open',
      accepted: { source_version: 2, source_entry_id: '66666666-6666-4666-8666-666666666666', committed_at: now, writer_agent: 'analyst', card_version_seq: 4, card_history_version: 4, card_history_entry_id: '11111111-1111-4111-8111-111111111111', content: 'Earlier accepted objective.', content_sha256: 'b'.repeat(64), size_bytes: 27 },
      draft: { opened_at: now, updated_at: now, content: objective, content_sha256: 'c'.repeat(64) },
      effective_content_source: 'draft',
    },
  });
}

function largeGraph() {
  const nodes = Array.from({ length: 42 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, '0');
    return {
      node_id: `node-${ordinal}`,
      agent_name: `custom-worker-${ordinal}`,
      session: { scope: 'card', identity_pattern: `agent:custom-worker-${ordinal}:<card-id>` },
      prompt: { source: 'bundled-shared', declaration: { reference: 'executor', compactable: true }, process: { reference: 'execute', compactable: true }, correction: { reference: 'correct-execute-result', compactable: true } },
      model: { route: 'executor', candidates: [{ provider: 'synthetic', model: 'synthetic-model' }], temperature: 0.2, max_tokens: 4096 },
      skills: true, tools: ['read'], child_creation_types: [], child_activation_types: [], readable_records: descriptors.map((record) => record.name), record_write_patterns: ['*.md'], requirements: [], descendant_context: null,
      outcomes: [`continue-along-the-long-custom-cycle-${ordinal}`],
    };
  });
  const edges = nodes.map((node, index) => ({
    source_node_id: node.node_id,
    outcome: node.outcomes[0], runtime_owned: false,
    condition: 'default', prompt: null,
    target: { kind: 'node', node_id: nodes[(index + 1) % nodes.length]!.node_id }, export_records: [], promotion: null,
  }));
  return {
    card_type: 'code', notification_recipient: 'executor', permitted_child_types: [],
    records: [...descriptors.map(({ current: _current, ...record }) => record), { name: graphLastMarker, format: 'markdown', schema: 'plain.v1', bootstrap: false }],
    entries: ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'].map((entry) => ({ entry, node_id: nodes[0]!.node_id, prompt: null })), nodes, edges,
    terminals: [{ terminal: 'DONE' }, { terminal: 'BLOCKED' }, { terminal: 'FAILED' }],
  };
}

function transcriptEntries() {
  return Array.from({ length: 18 }, (_, index) => ({
    id: `77777777-7777-4777-8${String(index).padStart(3, '0')}-777777777777`,
    session_id: sessionId, role: 'assistant', kind: 'text',
    content: index === 17 ? transcriptLastMarker : `Real synthetic fixture transcript message ${index + 1}: ${'readable transcript body '.repeat(8)}`,
    context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
    round_id: `r-assistant-${String(index + 1).padStart(32, '0')}`, message_index: index, block_index: 0, timestamp: now,
  }));
}

type Fixture = {
  requests: string[];
  recordReads: string[];
  recordOrder: string[];
  releaseHeldRefresh: () => void;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function json(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function installClarityFixture(page: Page): Promise<Fixture> {
  const requests: string[] = [];
  const recordReads: string[] = [];
  const recordOrder: string[] = [];
  const heldRefresh = deferred();
  let constraintsReads = 0;
  const graph = largeGraph();

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== 'GET') return route.fallback();
    requests.push(path);
    if (path === '/api/debug/graphs') return json(route, { error: 'InternalServerError', message: 'Internal server error' }, 500);

    if (path === '/api/state') return json(route, parseOperatorResponse('runtime.getState', 200, { projectId: 'project', runtime: { status: 'running', project_id: 'project', pid: 4242, started_at: now, current_card_id: smokeCardId, updated_at: now }, serverAvailability: smokeServerAvailability }));
    if (path === '/api/runtime/status') return json(route, parseOperatorResponse('runtime.status', 200, {
      runtime: 'running', currentCardId: smokeCardId, started_at: now, pid: 4242,
      actorRuntime: { pauseMode: 'running', cards: [{ cardId: smokeCardId, actorState: 'running', processState: { cardType: 'code', stateId: 'node:node-01', kind: 'node', nodeId: 'node-01', executionOrdinal: 37 } }] },
      oversight: { agent_name: 'oversight', session_id: 'agent:oversight:global', enabled: true, eligible: true, eligibility_reason: null, state: 'waiting', next_nominal_due: null, last_attempt: null, last_successful_at: null, service_epoch: now }, restart_server_available: false, serverAvailability: smokeServerAvailability,
    }));
    if (path === '/api/cards/project/children') return json(route, parseOperatorResponse('cards.children', 200, {
      parent: { id: 'project', type: 'project', title: 'Synthetic Project', status: 'running', permitted_child_types: ['goal', 'code'] },
      children: [
        { id: smokeCardId, type: 'code', title: longCardTitle, status: 'failed', permitted_child_types: [] },
        ...Array.from({ length: 24 }, (_, index) => ({
          id: `card-${String.fromCharCode(98 + index)}`,
          type: 'code',
          title: `Independent scrolling tree row ${String(index + 1).padStart(2, '0')}`,
          status: 'backlog',
          permitted_child_types: [],
        })),
      ],
    }));
    if (path === `/api/cards/${smokeCardId}`) return json(route, parseOperatorResponse('cards.get', 200, { card }));
    if (path === `/api/cards/${smokeCardId}/records`) {
      await json(route, parseOperatorResponse('cards.records.list', 200, { card_id: smokeCardId, records: descriptors }));
      recordOrder.push('descriptors:response');
      return;
    }
    if (path.startsWith(`/api/cards/${smokeCardId}/records/`)) {
      const name = decodeURIComponent(path.split('/').at(-1)!);
      recordReads.push(name);
      recordOrder.push(`content:request:${name}`);
      if (name === 'constraints.md') {
        constraintsReads += 1;
        if (constraintsReads > 1) {
          await heldRefresh.promise;
          return json(route, parseOperatorResponse('cards.records.get', 500, { error: 'InternalServerError', message: 'Internal server error' }), 500);
        }
      }
      return json(route, name === objectiveName ? objectiveRecord() : acceptedRecord(name, contents[name]!, descriptors.findIndex((descriptor) => descriptor.name === name) + 1));
    }
    if (path === `/api/cards/${smokeCardId}/agent-sessions`) return json(route, parseOperatorResponse('agents.cardSessions', 200, { card_id: smokeCardId, sessions: railSessions }));
    if (path === `/api/agents/${encodeURIComponent(sessionId)}`) return json(route, parseOperatorResponse('agents.detail', 200, { session: { id: sessionId, agent_name: 'executor', session_scope: 'card', card_id: smokeCardId, started_at: now, status: 'active', activity: 'busy', compaction: null } }));
    if (path === `/api/agents/${encodeURIComponent(sessionId)}/conversation`) {
      const entries = transcriptEntries();
      return json(route, parseOperatorResponse('agents.conversation', 200, { session_id: sessionId, segment_version: 1, segment_context: null, entries, cursor: { segment_version: 1, message_id: entries.at(-1)!.id } }));
    }
    if (path === `/api/workflows/${graph.card_type}/presentation`) return json(route, parseOperatorResponse('workflows.presentation', 200, {
      card_type: graph.card_type,
      nodes: graph.nodes.map(({ node_id, agent_name }) => ({ node_id, agent_name })),
      entries: graph.entries.map(({ entry, node_id }) => ({ entry, node_id })),
      edges: graph.edges.map(({ source_node_id, outcome, condition, target }) => ({ source_node_id, outcome, condition, target })),
      terminals: graph.terminals,
      records: graph.records.map(({ name, bootstrap }) => ({ name, bootstrap })),
    }));
    return route.fallback();
  });
  return { requests, recordReads, recordOrder, releaseHeldRefresh: heldRefresh.resolve };
}

async function setup(page: Page): Promise<{ base: Awaited<ReturnType<typeof installOperatorRestRoutes>>; fixture: Fixture }> {
  await page.addInitScript((value) => localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page);
  const base = await installOperatorRestRoutes(page);
  const fixture = await installClarityFixture(page);
  return { base, fixture };
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<string> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function openDetailsByKeyboard(page: Page, summary: ReturnType<Page['locator']>): Promise<void> {
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
}

test('work-first Overview uses custom current sources without request fan-out at desktop size', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { base, fixture } = await setup(page);
  await page.goto(`/cards/${smokeCardId}`);

  const overview = page.getByTestId('facet-overview');
  await expect(overview.getByRole('heading', { name: 'Objective' })).toBeVisible();
  const objectivePreview = overview.locator(`[data-record-name="${objectiveName}"]`);
  await expect(objectivePreview).toContainText(`From ${objectiveName}`);
  await expect(objectivePreview.getByTestId('record-source-state')).toHaveText('Draft');
  await expect(objectivePreview.getByTestId('record-excerpt')).toContainText('Make the operator overview');
  await expect(overview.getByTestId('overview-participants')).toContainText('Active — working now');
  await expect(overview.getByTestId('overview-result-line')).toContainText('The source refresh failed');
  await expect(overview.getByText('Synthetic blocked source: upstream evidence could not be refreshed.')).toBeVisible();
  await expect(overview.getByTestId('overview-records').locator('article > h4')).toHaveText([...extraNames]);
  await expect(overview.getByText('Synthetic Project', { exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('card-flow-outcomes').getByText('continue-along-the-long-custom-cycle-01', { exact: false })).toBeHidden();

  await openDetailsByKeyboard(page, objectivePreview.locator('summary', { hasText: 'Full content' }));
  await expect(objectivePreview.getByText(longTailMarker)).toBeVisible();
  const recordDetails = objectivePreview.locator('summary', { hasText: 'Record details' });
  await openDetailsByKeyboard(page, recordDetails);
  await expect(objectivePreview).toContainText('Head revision5');
  await expect(objectivePreview).toContainText('Accepted source revision2');
  await openDetailsByKeyboard(page, recordDetails);
  await openDetailsByKeyboard(page, objectivePreview.locator('summary', { hasText: 'Full content' }));

  await expect.poll(() => fixture.recordReads).toEqual([objectiveName, ...extraNames]);
  const descriptorIndex = fixture.requests.indexOf(`/api/cards/${smokeCardId}/records`);
  const firstContentIndex = fixture.requests.findIndex((path) => path.startsWith(`/api/cards/${smokeCardId}/records/`));
  expect(descriptorIndex).toBeGreaterThanOrEqual(0);
  expect(firstContentIndex).toBeGreaterThan(descriptorIndex);
  expect(fixture.recordOrder[0]).toBe('descriptors:response');
  expect(fixture.recordOrder.slice(1, 5)).toEqual([
    `content:request:${objectiveName}`,
    ...extraNames.map((name) => `content:request:${name}`),
  ]);
  expect(fixture.requests.some((path) => path.includes('/history') || path.includes('/diff'))).toBe(false);
  expect(fixture.requests).not.toContain(`/api/agents/${encodeURIComponent(sessionId)}/conversation`);
  expect(base.counts.get('GET /api/agents') ?? 0).toBe(0);

  await page.evaluate(({ cardId }) => window.__saivageWsFixture?.emit({ t: 'invalidate', resource: 'cards', scope: 'record', card_id: cardId, record_name: 'constraints.md' }), { cardId: smokeCardId });
  const constraints = overview.locator('[data-record-name="constraints.md"]');
  await expect(constraints).toContainText('Last loaded · stale');
  await expect(constraints).toContainText('These are neutral source constraints');
  fixture.releaseHeldRefresh();
  await expect(constraints).toContainText('Internal server error');
  await expect(objectivePreview).toContainText('Make the operator overview');

  await overview.evaluate((element) => { element.scrollTop = 0; });
  await screenshot(page, testInfo, 'cockpit-overview-collapsed-1440x900.png');
  const recordsLink = overview.getByRole('link', { name: 'Records & History', exact: true });
  await recordsLink.click();
  await expect(page).toHaveURL(new RegExp(`facet=records`));
  await expect(page.getByTestId('facet-records')).toBeVisible();
  await screenshot(page, testInfo, 'cockpit-records-collapsed-header-1440x900.png');
  const query = new URL(page.url()).searchParams;
  expect([...query.keys()]).toEqual(['facet']);
  expect(query.get('facet')).toBe('records');
  expect(base.unknown).toEqual([]);
});

test('constrained shared Cockpit keeps exact conversation context and independent scrolling', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const { base, fixture } = await setup(page);
  await page.goto(`/cards/${smokeCardId}`);
  await expect(page.getByTestId('facet-overview').getByText('Parent and related work')).toBeAttached();

  await screenshot(page, testInfo, 'cockpit-overview-collapsed-900x700.png');
  await page.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Records & History', exact: true }).click();
  await expect(page.getByTestId('facet-records')).toBeVisible();
  await screenshot(page, testInfo, 'cockpit-records-collapsed-header-900x700.png');
  await page.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('facet-overview')).toBeVisible();

  const cockpitCenter = page.locator('.cockpit-center');
  const header = cockpitCenter.locator('.card-flow-header');
  const technicalSummary = header.locator('summary', { hasText: 'Workflow & technical details' });
  await openDetailsByKeyboard(page, technicalSummary);
  await expect(header.getByTestId('card-flow-outcomes').getByText('continue-along-the-long-custom-cycle-01', { exact: false })).toBeVisible();
  const topology = header.locator('.flow-graph-details');
  await expect(topology).toContainText('custom-worker-42');
  await expect(topology).toContainText('BACKLOG → node node-01');
  await expect(topology).toContainText('continue-along-the-long-custom-cycle-42 (default)→ node node-01');
  const terminals = topology.locator('.flow-graph-row').filter({ hasText: 'Terminals:' });
  for (const terminal of ['DONE', 'BLOCKED', 'FAILED']) await expect(terminals).toContainText(terminal);
  await expect(topology).toContainText(`${objectiveName} (bootstrap)`);

  const cockpitMetrics = await page.evaluate(() => {
    const center = document.querySelector<HTMLElement>('.cockpit-center')!;
    const head = center.querySelector<HTMLElement>('.card-flow-header')!;
    const body = center.querySelector<HTMLElement>('[data-testid="facet-overview"]')!;
    const rect = (element: HTMLElement) => { const value = element.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width, height: value.height }; };
    return { viewport: { width: innerWidth, height: innerHeight }, center: rect(center), header: rect(head), body: rect(body), centerClient: center.clientHeight, centerScroll: center.scrollHeight, headerClient: head.clientHeight, headerScroll: head.scrollHeight, bodyClient: body.clientHeight, bodyScroll: body.scrollHeight };
  });
  expect(cockpitMetrics.header.height).toBeLessThanOrEqual(cockpitMetrics.center.height * 0.45 + 2);
  expect(cockpitMetrics.headerScroll).toBeGreaterThan(cockpitMetrics.headerClient);
  expect(cockpitMetrics.body.height).toBeGreaterThanOrEqual(200);
  expect(cockpitMetrics.bodyScroll).toBeGreaterThan(cockpitMetrics.bodyClient);
  expect(cockpitMetrics.centerScroll).toBeLessThanOrEqual(cockpitMetrics.centerClient + 1);
  expect(cockpitMetrics.center.top).toBeGreaterThanOrEqual(0);
  expect(cockpitMetrics.header.left).toBeGreaterThanOrEqual(0);
  expect(cockpitMetrics.center.bottom).toBeLessThanOrEqual(cockpitMetrics.viewport.height + 1);
  expect(cockpitMetrics.header.right).toBeLessThanOrEqual(cockpitMetrics.viewport.width + 1);

  await header.focus();
  const headerBefore = await header.evaluate((element) => element.scrollTop);
  await page.keyboard.press('PageDown');
  await expect.poll(() => header.evaluate((element) => element.scrollTop)).toBeGreaterThan(headerBefore);
  await header.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(header.getByText(graphLastMarker)).toBeVisible();
  const overview = page.getByTestId('facet-overview');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
  await header.evaluate((element) => { element.scrollTop = 137; });
  const settledHeaderScroll = await header.evaluate((element) => element.scrollTop);
  await overview.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(overview.getByText('Parent and related work')).toBeVisible();
  expect(await header.evaluate((element) => element.scrollTop)).toBe(settledHeaderScroll);
  await header.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await screenshot(page, testInfo, 'cockpit-overview-expanded-900x700.png');

  await page.goto(`/agents/${encodeURIComponent(sessionId)}`);
  const session = page.getByTestId('route-cockpit');
  await expect(page.getByLabel('Analyst chat composer')).toBeVisible();
  await expect(session.getByTestId('card-flow-title')).toHaveText(longCardTitle);
  await expect(session.getByTestId('cockpit-facet-nav')).toContainText('Records & History');
  const conversationsTab = session.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Conversations', exact: true });
  await expect(conversationsTab).toHaveClass(/active/);
  await conversationsTab.focus();
  await expect(conversationsTab).toBeFocused();
  const selectedParticipant = session.getByRole('button', { name: new RegExp(sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  await selectedParticipant.focus();
  await expect(selectedParticipant).toBeFocused();
  const firstTranscriptMessage = session.getByText(/^Real synthetic fixture transcript message 1:/);
  await expect(firstTranscriptMessage).toBeAttached();
  const sessionHeader = session.locator('.card-flow-header');
  await openDetailsByKeyboard(page, sessionHeader.locator('summary', { hasText: 'Workflow & technical details' }));
  const rounds = session.locator('.conv-rounds');
  const sessionMetrics = await page.evaluate(() => {
    const route = document.querySelector<HTMLElement>('[data-testid="route-cockpit"]')!;
    const head = route.querySelector<HTMLElement>('.card-flow-header')!;
    const transcript = route.querySelector<HTMLElement>('.conv-rounds')!;
    const rect = (element: HTMLElement) => { const value = element.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width, height: value.height }; };
    return { viewport: { width: innerWidth, height: innerHeight }, route: rect(route), header: rect(head), transcript: rect(transcript), routeClient: route.clientHeight, routeScroll: route.scrollHeight, headerClient: head.clientHeight, headerScroll: head.scrollHeight, transcriptClient: transcript.clientHeight, transcriptScroll: transcript.scrollHeight };
  });
  expect(sessionMetrics.header.height).toBeLessThanOrEqual(sessionMetrics.route.height * 0.45 + 2);
  expect(sessionMetrics.headerScroll).toBeGreaterThan(sessionMetrics.headerClient);
  expect(sessionMetrics.transcript.height).toBeGreaterThanOrEqual(160);
  expect(sessionMetrics.transcriptScroll).toBeGreaterThan(sessionMetrics.transcriptClient);
  expect(sessionMetrics.routeScroll).toBeLessThanOrEqual(sessionMetrics.routeClient + 1);
  expect(sessionMetrics.route.top).toBeGreaterThanOrEqual(0);
  expect(sessionMetrics.header.left).toBeGreaterThanOrEqual(0);
  expect(sessionMetrics.route.bottom).toBeLessThanOrEqual(sessionMetrics.viewport.height + 1);
  expect(sessionMetrics.transcript.right).toBeLessThanOrEqual(sessionMetrics.viewport.width + 1);

  const treeScroll = session.locator('.cockpit-tree-scroll');
  const participantRail = session.locator('.participant-rail');
  const independentScrollMetrics = await Promise.all([
    treeScroll.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight })),
    participantRail.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight })),
    rounds.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight })),
  ]);
  for (const metrics of independentScrollMetrics) expect(metrics.scroll).toBeGreaterThan(metrics.client);
  await treeScroll.evaluate((element) => { element.scrollTop = 0; });
  await participantRail.evaluate((element) => { element.scrollTop = 0; });
  await rounds.evaluate((element) => { element.scrollTop = 0; });
  await treeScroll.evaluate((element) => { element.scrollTop = 120; });
  const treePosition = await treeScroll.evaluate((element) => element.scrollTop);
  expect(treePosition).toBeGreaterThan(0);
  expect(await participantRail.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await rounds.evaluate((element) => element.scrollTop)).toBe(0);
  await participantRail.evaluate((element) => { element.scrollTop = 120; });
  const railPosition = await participantRail.evaluate((element) => element.scrollTop);
  expect(railPosition).toBeGreaterThan(0);
  expect(await treeScroll.evaluate((element) => element.scrollTop)).toBe(treePosition);
  expect(await rounds.evaluate((element) => element.scrollTop)).toBe(0);
  await rounds.evaluate((element) => { element.scrollTop = 120; });
  expect(await rounds.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await treeScroll.evaluate((element) => element.scrollTop)).toBe(treePosition);
  expect(await participantRail.evaluate((element) => element.scrollTop)).toBe(railPosition);

  const analystComposer = page.getByLabel('Analyst chat composer');
  await analystComposer.focus();
  await expect(analystComposer).toBeFocused();

  await sessionHeader.focus();
  const sessionHeaderBefore = await sessionHeader.evaluate((element) => element.scrollTop);
  await page.keyboard.press('PageDown');
  await expect.poll(() => sessionHeader.evaluate((element) => element.scrollTop)).toBeGreaterThan(sessionHeaderBefore);
  await sessionHeader.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(sessionHeader.getByText(graphLastMarker)).toBeVisible();
  await rounds.evaluate((element) => { element.scrollTop = 0; });
  await expect(firstTranscriptMessage).toBeVisible();
  await rounds.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(session.getByText(transcriptLastMarker)).toBeVisible();
  await screenshot(page, testInfo, 'cockpit-conversation-expanded-900x700.png');

  expect(base.unknown).toEqual([]);
  expect(base.counts.get('GET /api/debug/graphs') ?? 0).toBe(0);
  expect(fixture.requests).not.toContain('/api/debug/graphs');
});
