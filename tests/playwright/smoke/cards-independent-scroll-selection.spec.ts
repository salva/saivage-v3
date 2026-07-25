import { expect, test, type Page, type Route } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const token = 'synthetic-cards-scroll-token';
const now = '2026-07-17T12:00:00.000Z';
const sourceId = 'card-a';
const goalId = 'card-b';
const targetId = 'card-b-c';
const newId = 'card-b-d';
const obsoleteId = 'card-z-z';

function card(id: string, title: string, children: string[] = [], status: 'backlog' | 'running' | 'blocked' = 'backlog') {
  return {
    id,
    type: id === 'project' ? 'project' : id === goalId ? 'goal' : 'code',
    children,
    title,
    subtype: null,
    lifecycle: { status, result: status === 'blocked' ? { kind: 'workflow-result', terminal: 'BLOCKED', agent_name: 'executor', node_id: 'execute', outcome: 'blocked', summary: 'blocked', records: [] } : null, error: status === 'blocked' ? 'blocked' : null, completed_at: null },
    operator_summary: { blocked: status === 'blocked', hasError: false, error: null, completedAt: null, stale: false },
    tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now,
    assigned_to: null, depends_on: [], related: [], metrics: null, estimate: null, started_at: null, duration_ms: null,
    status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null,
    pending_notifications: [], allowedActions: [], version_seq: 1,
  };
}

function segment(index: number): string {
  let value = index;
  let output = '';
  while (value > 0) { value -= 1; output = String.fromCharCode(97 + (value % 26)) + output; value = Math.floor(value / 26); }
  return output;
}
const overflow = Array.from({ length: 28 }, (_, index) => card(`card-${segment(index + 5)}`, `Overflow ${index + 1}`));
const source = card(sourceId, 'Source card', [], 'running');
const goal = card(goalId, 'Collapsed ancestor goal', [targetId, newId]);
const target = { ...card(targetId, 'Deep linked target'), version_seq: 3 };
const targetPrior = { ...target, title: 'Earlier target', version_seq: 2 };
const newlyLinked = card(newId, 'Current detail outside retained slice');
const project = card('project', 'Cards fixture project', [sourceId, goalId, ...overflow.map((entry) => entry.id)], 'running');
const hierarchy=(value:ReturnType<typeof card>)=>({id:value.id,type:value.type,title:value.title,status:value.lifecycle.status});
const detailProjection=(value:ReturnType<typeof card>)=>({id:value.id,type:value.type,title:value.title,lifecycle:value.lifecycle,version_seq:value.version_seq,urgency:value.urgency,created_at:value.created_at,updated_at:value.updated_at,allowedActions:value.allowedActions});
const recordsFor = (id: string) => id === targetId ? [
  { name: 'brief.md', format: 'markdown' as const, schema: 'brief.v1', writers: ['analyst'], bootstrap: true },
  { name: 'status.md', format: 'markdown' as const, schema: 'status.v1', writers: ['executor'], bootstrap: false },
  { name: 'review.md', format: 'markdown' as const, schema: 'review.v1', writers: ['reviewer'], bootstrap: false },
  { name: 'decision.md', format: 'markdown' as const, schema: 'decision.v1', writers: ['reviewer'], bootstrap: false },
] : id === goalId ? [
  { name: 'brief.md', format: 'markdown' as const, schema: 'brief.v1', writers: ['analyst', 'planner'], bootstrap: true },
  { name: 'status.md', format: 'markdown' as const, schema: 'status.v1', writers: ['planner'], bootstrap: false },
  { name: 'review.md', format: 'markdown' as const, schema: 'review.v1', writers: ['reviewer'], bootstrap: false },
] : [
  { name: 'brief.md', format: 'markdown' as const, schema: 'brief.v1', writers: ['analyst'], bootstrap: true },
  { name: 'status.md', format: 'markdown' as const, schema: 'status.v1', writers: ['executor'], bootstrap: false },
];

type RecordReply = { status: number; content?: string };
type Fixture = { requests: string[]; omitNewEdge: boolean; missingDetails: Set<string>; detailDelay: Map<string, Promise<void>>; hierarchyDelay: Map<string, Promise<void>>; recordDelay: Map<string, Promise<void>>; historyDelay: Map<string, Promise<void>>; recordReplies: Map<string, RecordReply[]> };
async function json(route: Route, payload: unknown, status = 200) { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) }); }

async function install(page: Page): Promise<Fixture> {
  await page.addInitScript((value) => localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page);
  await installOperatorRestRoutes(page);
  const fixture: Fixture = { requests: [], omitNewEdge: false, missingDetails: new Set(), detailDelay: new Map(), hierarchyDelay: new Map(), recordDelay: new Map(), historyDelay: new Map(), recordReplies: new Map() };
  await page.route('**/api/cards**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    fixture.requests.push(`${request.method()} ${url.pathname}`);
    if (request.method() !== 'GET') return route.fallback();
    if (url.pathname === '/api/cards/project/children') {
      await fixture.hierarchyDelay.get('project');
      return json(route, parseOperatorResponse('cards.children', { parent: hierarchy(project), children: [source, goal, ...overflow].map(hierarchy) }));
    }
    if (url.pathname === `/api/cards/${goalId}/children`) {
      return json(route, parseOperatorResponse('cards.children', { parent: hierarchy(goal), children: (fixture.omitNewEdge ? [target] : [target, newlyLinked]).map(hierarchy) }));
    }
    if (url.pathname === `/api/cards/${targetId}/history`) {
      await fixture.historyDelay.get(targetId);
      return json(route, parseOperatorResponse('cards.history.list', { history: [{
        entry_id: '11111111-1111-4111-8111-111111111111', kind: 'update', card_id: targetId, version_seq: 2,
        changed_at: now, changed_by_actor: 'planner', changed_by_surface: 'runtime', change_reason: 'planner edit_card',
        changed_fields: ['title'], change_summary: 'title updated',
      }], total: 1 }));
    }
    if (url.pathname === `/api/cards/${targetId}/history/2`) {
      const { operator_summary: _operatorSummary, allowedActions: _allowedActions, ...snapshot } = targetPrior;
      return json(route, parseOperatorResponse('cards.history.get', { entry: {
        entry_id: '11111111-1111-4111-8111-111111111111', kind: 'update', card_id: targetId, version_seq: 2,
        changed_at: now, changed_by_actor: 'planner', changed_by_surface: 'runtime', change_reason: 'planner edit_card',
        changed_fields: ['title'], change_summary: 'title updated', snapshot,
      } }));
    }
    if (url.pathname === `/api/cards/${targetId}/diff`) {
      return json(route, parseOperatorResponse('cards.diff', { card_id: targetId, from: 2, to: 3, diff: [{ field: 'title', before: 'Earlier target', after: target.title }] }));
    }
    const childrenMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/children$/);
    if (childrenMatch) {
      const id = decodeURIComponent(childrenMatch[1]!);
      const found = [source, target, newlyLinked, ...overflow].find((entry) => entry.id === id);
      return found ? json(route, parseOperatorResponse('cards.children', { parent: hierarchy(found), children: [] })) : json(route, { error: 'Card not found', cardId: id }, 404);
    }
    const recordMatch=url.pathname.match(/^\/api\/cards\/([^/]+)\/records\/([^/]+)$/);
    if(recordMatch){const cardId=decodeURIComponent(recordMatch[1]!);const name=decodeURIComponent(recordMatch[2]!);const stem=name.replace(/\.md$/,'');const key=`${cardId}:${stem}`;await fixture.recordDelay.get(key);const queued=fixture.recordReplies.get(key)?.shift();if(queued&&queued.status!==200)return json(route,queued.status===404?{error:'Card record not found',cardId,name}:{error:'InternalServerError',message:'Internal server error'},queued.status);if(!queued&&name!=='brief.md')return json(route,{error:'Card record not found',cardId,name},404);const content=queued?.content??(cardId===targetId?`Continue with [[card:${sourceId}|Source card]].`:'Brief content');return json(route,parseOperatorResponse('cards.records.get',{card_id:cardId,record:{name,version:2,committed_at:now,content}}));}
    const recordsMatch=url.pathname.match(/^\/api\/cards\/([^/]+)\/records$/);
    if(recordsMatch){const id=decodeURIComponent(recordsMatch[1]!);return json(route,parseOperatorResponse('cards.records.list',{card_id:id,records:recordsFor(id)}));}
    const detailMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      await fixture.detailDelay.get(id);
      if (fixture.missingDetails.has(id)) return json(route, { error: 'Card not found', cardId: id }, 404);
      const found = [project, source, goal, target, newlyLinked, ...overflow].find((entry) => entry.id === id);
      const detailCard = found && id === goalId ? { ...found, title: 'Detail authority goal' } : found;
      return detailCard ? json(route, parseOperatorResponse('cards.get', { card: detailProjection(detailCard) })) : json(route, { error: 'Card not found', cardId: id }, 404);
    }
    return route.fallback();
  });
  await page.route('**/api/files/content**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '';
    if (!path.startsWith('record:///')) return route.fallback();
    throw new Error(`Cards must not use generic Files record URL '${path}'.`);
  });
  return fixture;
}

function selected(page: Page) { return page.locator('.tree-node[aria-current="true"]'); }
async function navigateSpa(page: Page, path: string): Promise<void> {
  await page.evaluate((nextPath) => {
    window.history.pushState({}, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('cold deep route requests only represented ancestor slices and separate detail', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/cards/${targetId}`);
  await expect(selected(page)).toContainText('Deep linked target');
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Deep linked target');
  await expect.poll(() => fixture.requests).toEqual(expect.arrayContaining([
    'GET /api/cards/project/children',
    `GET /api/cards/${goalId}/children`,
    `GET /api/cards/${targetId}`,
  ]));
  expect(fixture.requests).not.toContain('GET /api/cards');
  expect(fixture.requests).not.toContain(`GET /api/cards/${sourceId}/children`);
});

test('collapsed branch is lazy, expands once in committed order, and never refreshes a successful slice', async ({ page }) => {
  const fixture = await install(page);
  await page.goto('/cards');
  await page.getByRole('button', { name: 'Expand Cards fixture project', exact: true }).click();
  await expect(page.locator('.tree-node').filter({ hasText: 'Collapsed ancestor goal' })).toBeVisible();
  expect(fixture.requests).not.toContain(`GET /api/cards/${goalId}/children`);
  await page.getByRole('button', { name: 'Expand Collapsed ancestor goal', exact: true }).click();
  await expect(page.locator('.tree-node').filter({ hasText: 'Deep linked target' })).toBeVisible();
  const branchRows = page.locator('.tree-node').filter({ hasText: /Deep linked target|Current detail outside retained slice/ });
  await expect(branchRows).toHaveCount(2);
  await page.getByRole('button', { name: 'Collapse Collapsed ancestor goal', exact: true }).click();
  await page.getByRole('button', { name: 'Expand Collapsed ancestor goal', exact: true }).click();
  expect(fixture.requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`)).toHaveLength(1);
});

test('retained stale slice can leave current detail visible without row or Path', async ({ page }) => {
  const fixture = await install(page);
  fixture.omitNewEdge = true;
  await page.goto(`/cards/${targetId}`);
  await expect(selected(page)).toContainText('Deep linked target');
  const branchReads = fixture.requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`).length;
  await navigateSpa(page, `/cards/${newId}`);
  await expect(page).toHaveURL(`/cards/${newId}`);
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Current detail outside retained slice');
  await expect(selected(page)).toHaveCount(0);
  await expect(page.getByText('Path', { exact: true })).toHaveCount(0);
  expect(fixture.requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`)).toHaveLength(branchReads);
  expect(fixture.requests).not.toContain(`GET /api/cards/${newId}/children`);
});

test('direct obsolete card URL explains terminal absence, retains the tree, and preserves explicit history recovery', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await install(page);
  fixture.missingDetails.add(obsoleteId);
  await page.goto(`/cards/${obsoleteId}`);
  await expect(page.getByText('Card not found', { exact: true })).toBeVisible();
  await expect(page.getByText('This card is not available in the current hierarchy. This link may be obsolete after a reset.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect.poll(() => fixture.requests.filter((entry) => entry === `GET /api/cards/${obsoleteId}`).length).toBe(1);
  const tree = page.locator('.tree-container'); await tree.evaluate((element) => element.setAttribute('data-identity', 'obsolete-retained'));
  const rootReads = fixture.requests.filter((entry) => entry === 'GET /api/cards/project/children').length;
  await expect(page.locator('button:visible', { hasText: 'Back to Cards' })).toHaveCount(1);
  await page.setViewportSize({ width: 700, height: 720 });
  await expect(page.getByText('This card is not available in the current hierarchy. This link may be obsolete after a reset.', { exact: true })).toBeVisible();
  await expect(page.locator('button:visible', { hasText: 'Back to Cards' })).toHaveCount(1);
  await page.locator('button:visible', { hasText: 'Back to Cards' }).click();
  await expect(page).toHaveURL('/cards'); await expect(tree).toHaveAttribute('data-identity', 'obsolete-retained');
  expect(fixture.requests.filter((entry) => entry === `GET /api/cards/${obsoleteId}`)).toHaveLength(1); expect(fixture.requests.filter((entry) => entry === 'GET /api/cards/project/children')).toHaveLength(rootReads);
  await page.goBack(); await expect(page).toHaveURL(`/cards/${obsoleteId}`); await expect.poll(() => fixture.requests.filter((entry) => entry === `GET /api/cards/${obsoleteId}`).length).toBe(2); await expect(page.getByText('Card not found', { exact: true })).toBeVisible();
  await page.goForward(); await expect(page).toHaveURL('/cards'); expect(fixture.requests.filter((entry) => entry === `GET /api/cards/${obsoleteId}`)).toHaveLength(2); expect(fixture.requests.filter((entry) => entry === 'GET /api/cards/project/children')).toHaveLength(rootReads);
  await navigateSpa(page, `/cards/${sourceId}`); await expect(page.getByTestId('card-detail-highlight')).toContainText('Source card'); expect(fixture.requests.filter((entry) => entry === `GET /api/cards/${sourceId}`)).toHaveLength(1);
});

test('refresh detail 404 aborts selected resources, blocks healing fan-out, and leaves hierarchy independently refreshable', async ({ page }) => {
  const fixture = await install(page); await page.goto(`/cards/${targetId}`);
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Deep linked target');
  await page.getByText('Version history', { exact: true }).click(); await expect(page.getByText('title updated', { exact: true })).toBeVisible(); await expect(page.getByText('Diff vs current card', { exact: true })).toBeVisible();
  const tree = page.locator('.tree-container'); await tree.evaluate((element) => element.setAttribute('data-identity', 'refresh-404-retained'));
  let releaseRecord!: () => void; let releaseHistory!: () => void;
  fixture.recordDelay.set(`${targetId}:brief`, new Promise<void>((resolve) => { releaseRecord = resolve; })); fixture.historyDelay.set(targetId, new Promise<void>((resolve) => { releaseHistory = resolve; }));
  const briefPath = `GET /api/cards/${targetId}/records/brief.md`;
  const briefBefore = fixture.requests.filter((entry) => entry === briefPath).length; const historyBefore = fixture.requests.filter((entry) => entry === `GET /api/cards/${targetId}/history`).length;
  await page.evaluate((frames) => { for (const frame of frames) window.__saivageWsFixture?.emit(frame); }, [
    { t: 'invalidate', resource: 'cards', scope: 'record', card_id: targetId, record_name: 'brief.md' },
    { t: 'invalidate', resource: 'cards', scope: 'history', card_id: targetId },
  ]);
  await expect.poll(() => fixture.requests.filter((entry) => entry === briefPath).length).toBe(briefBefore + 1); await expect.poll(() => fixture.requests.filter((entry) => entry === `GET /api/cards/${targetId}/history`).length).toBe(historyBefore + 1);
  fixture.missingDetails.add(targetId); await page.evaluate((frame) => window.__saivageWsFixture?.emit(frame), { t: 'invalidate', resource: 'cards', scope: 'detail', card_id: targetId });
  await expect(page.getByText('Card not found', { exact: true })).toBeVisible(); await expect(page.getByTestId('card-detail-highlight')).toHaveCount(0); await expect(page.getByText('title updated', { exact: true })).toHaveCount(0); await expect(page.getByText(/Continue with/)).toHaveCount(0);
  releaseRecord(); releaseHistory(); await page.evaluate(() => Promise.resolve()); await expect(page.getByText('Card not found', { exact: true })).toBeVisible();
  const selectedReads = () => fixture.requests.filter((entry) => entry === `GET /api/cards/${targetId}` || entry.startsWith(`GET /api/cards/${targetId}/records`) || entry.startsWith(`GET /api/cards/${targetId}/history`) || entry.startsWith(`GET /api/cards/${targetId}/diff`)).length;
  const selectedBaseline = selectedReads();
  await page.evaluate((frames) => { for (const frame of frames) window.__saivageWsFixture?.emit(frame); }, [
    { t: 'invalidate', resource: 'cards', scope: 'detail', card_id: targetId },
    { t: 'invalidate', resource: 'cards', scope: 'record', card_id: targetId, record_name: 'brief.md' },
    { t: 'invalidate', resource: 'cards', scope: 'history', card_id: targetId },
    { t: 'invalidate', resource: 'cards', scope: 'diff', card_id: targetId },
  ]); await page.evaluate(() => Promise.resolve()); expect(selectedReads()).toBe(selectedBaseline);
  const goalBefore = fixture.requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`).length;
  await page.evaluate((frame) => window.__saivageWsFixture?.emit(frame), { t: 'invalidate', resource: 'cards', scope: 'children', card_id: goalId }); await expect.poll(() => fixture.requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`).length).toBe(goalBefore + 1);
  const rootBefore = fixture.requests.filter((entry) => entry === 'GET /api/cards/project/children').length; const goalAfterInvalidate = fixture.requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`).length;
  await page.evaluate(() => window.__saivageWsFixture?.closeAll()); await expect.poll(() => fixture.requests.filter((entry) => entry === 'GET /api/cards/project/children').length).toBe(rootBefore + 1); await expect.poll(() => fixture.requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`).length).toBe(goalAfterInvalidate + 1);
  expect(selectedReads()).toBe(selectedBaseline); await expect(tree).toHaveAttribute('data-identity', 'refresh-404-retained'); await expect(page.getByText('Card not found', { exact: true })).toBeVisible();
});

test('rapid route navigation supersedes a pending deep reveal without cancelling shared root work', async ({ page }) => {
  const fixture = await install(page);
  let releaseRoot!: () => void;
  fixture.hierarchyDelay.set('project', new Promise<void>((resolve) => { releaseRoot = resolve; }));
  await page.goto(`/cards/${targetId}`);
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Deep linked target');
  await navigateSpa(page, `/cards/${sourceId}`);
  await expect(page).toHaveURL(`/cards/${sourceId}`);
  releaseRoot();
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Source card');
  await expect(selected(page)).toContainText('Source card');
  expect(fixture.requests).not.toContain(`GET /api/cards/${goalId}/children`);
  expect(fixture.requests.filter((entry) => entry === 'GET /api/cards/project/children')).toHaveLength(1);
  await page.goBack();
  await expect(page).toHaveURL(`/cards/${targetId}`);
  await expect(selected(page)).toContainText('Deep linked target');
  await page.goForward();
  await expect(page).toHaveURL(`/cards/${sourceId}`);
  await expect(selected(page)).toContainText('Source card');
  expect(fixture.requests.filter((entry) => entry === 'GET /api/cards/project/children')).toHaveLength(1);
});

test('canonical record links navigate to their exact card route', async ({ page }) => {
  await install(page);
  await page.goto(`/cards/${targetId}`);
  await expect(page.getByRole('link', { name: 'Source card' })).toBeVisible();
  await page.getByRole('link', { name: 'Source card' }).click();
  await expect(page).toHaveURL(`/cards/${sourceId}`);
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Source card');
});

test('hierarchy rows and selected detail retain disjoint authority in both completion orders', async ({ page }) => {
  const fixture = await install(page);
  let releaseHierarchy!: () => void;
  fixture.hierarchyDelay.set('project', new Promise<void>((resolve) => { releaseHierarchy = resolve; }));
  await page.goto(`/cards/${goalId}`);
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Detail authority goal');
  releaseHierarchy();
  await expect(page.locator('.tree-node').filter({ hasText: 'Collapsed ancestor goal' })).toBeVisible();
  await expect(page.locator('.tree-node').filter({ hasText: 'Detail authority goal' })).toHaveCount(0);

  fixture.hierarchyDelay.clear();
  let releaseDetail!: () => void;
  fixture.detailDelay.set(goalId, new Promise<void>((resolve) => { releaseDetail = resolve; }));
  await page.reload();
  await expect(page.locator('.tree-node').filter({ hasText: 'Collapsed ancestor goal' })).toBeVisible();
  await expect(page.getByText('Loading card', { exact: true })).toBeVisible();
  releaseDetail();
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Detail authority goal');
  await expect(page.locator('.tree-node').filter({ hasText: 'Collapsed ancestor goal' })).toBeVisible();
});

test('tree remains mounted and independently scrollable while detail is delayed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  const fixture = await install(page);
  await page.goto('/cards');
  await page.getByRole('button', { name: 'Expand Cards fixture project', exact: true }).click();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  fixture.detailDelay.set(sourceId, pending);
  const tree = page.locator('.tree-container');
  await tree.evaluate((element) => element.setAttribute('data-identity', 'retained'));
  await page.locator('.tree-node').filter({ hasText: 'Source card' }).click();
  await expect(page.getByText('Loading card', { exact: true })).toBeVisible();
  await expect(tree).toHaveAttribute('data-identity', 'retained');
  release();
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Source card');
  const treePane = page.locator('.cards-md__tree');
  const detailPane = page.locator('.card-detail-container');
  await expect.poll(() => treePane.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  await expect.poll(() => detailPane.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
});

test('mobile Back returns to the retained lazy tree', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 720 });
  await install(page);
  await page.goto('/cards');
  await page.getByRole('button', { name: 'Expand Cards fixture project', exact: true }).click();
  await page.locator('.tree-node').filter({ hasText: 'Source card' }).click();
  await expect(page).toHaveURL(`/cards/${sourceId}`);
  await page.getByRole('button', { name: 'Back to Cards' }).click();
  await expect(page).toHaveURL('/cards');
  await expect(page.locator('.tree-node').filter({ hasText: 'Source card' })).toBeVisible();
});

test('exact record invalidation retains failed content until one operator Retry', async ({ page }) => {
  const fixture = await install(page);
  fixture.recordReplies.set(`${targetId}:brief`, [
    { status: 200, content: 'Accepted brief remains visible.' },
    { status: 404 },
    { status: 503 },
    { status: 200, content: 'Retried brief replacement.' },
  ]);
  await page.goto(`/cards/${targetId}`);
  await expect(page.getByText('Accepted brief remains visible.')).toBeVisible();
  const briefPath = `GET /api/cards/${targetId}/records/brief.md`;
  await page.evaluate((frame) => window.__saivageWsFixture?.emit(frame), { t: 'invalidate', resource: 'cards', scope: 'record', card_id: targetId, record_name: 'brief.md' });
  await expect(page.getByText('Accepted brief remains visible.')).toBeVisible();
  await expect(page.getByText('Card record not found')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  const failedCount = fixture.requests.filter((entry) => entry === briefPath).length;
  await page.evaluate(() => Promise.resolve());
  expect(fixture.requests.filter((entry) => entry === briefPath)).toHaveLength(failedCount);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Accepted brief remains visible.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await page.evaluate(() => Promise.resolve());
  expect(fixture.requests.filter((entry) => entry === briefPath)).toHaveLength(failedCount + 1);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Retried brief replacement.')).toBeVisible();
  expect(fixture.requests.filter((entry) => entry === briefPath)).toHaveLength(failedCount + 2);
});

test('reconnect snapshots loaded scopes once and keeps accepted-empty optional records current on 404', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/cards/${targetId}`);
  await expect(page.getByText('No review.md record yet.')).toBeVisible();
  const rootBefore = fixture.requests.filter((entry) => entry === 'GET /api/cards/project/children').length;
  const reviewPath = `GET /api/cards/${targetId}/records/review.md`;
  const reviewBefore = fixture.requests.filter((entry) => entry === reviewPath).length;
  await page.evaluate(() => window.__saivageWsFixture?.closeAll());
  await expect.poll(() => fixture.requests.filter((entry) => entry === 'GET /api/cards/project/children').length).toBe(rootBefore + 1);
  await expect.poll(() => fixture.requests.filter((entry) => entry === reviewPath).length).toBe(reviewBefore + 1);
  await expect(page.getByText('No review.md record yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  expect(fixture.requests).not.toContain(`GET /api/cards/${sourceId}/children`);
});

test('switching cards aborts and excludes a late old-card record completion', async ({ page }) => {
  const fixture = await install(page);
  let release!: () => void;
  fixture.recordDelay.set(`${targetId}:brief`, new Promise<void>((resolve) => { release = resolve; }));
  fixture.recordReplies.set(`${targetId}:brief`, [{ status: 200, content: 'Late old-card brief.' }]);
  await page.goto(`/cards/${targetId}`);
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Deep linked target');
  await navigateSpa(page, `/cards/${sourceId}`);
  await expect(page.getByTestId('card-detail-highlight')).toContainText('Source card');
  release();
  await page.evaluate(() => Promise.resolve());
  await expect(page.getByText('Late old-card brief.')).toHaveCount(0);
});

test('unselected card history and diff invalidations do not reload the selected history surface', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/cards/${targetId}`);
  await page.getByText('Version history', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Card history', exact: true })).toBeVisible();
  await expect(page.getByText('title updated', { exact: true })).toBeVisible();
  await expect(page.getByText('Diff vs current card', { exact: true })).toBeVisible();
  const before = [...fixture.requests];
  await page.evaluate((frames) => { for (const frame of frames) window.__saivageWsFixture?.emit(frame); }, [
    { t: 'invalidate', resource: 'cards', scope: 'history', card_id: sourceId },
    { t: 'invalidate', resource: 'cards', scope: 'diff', card_id: sourceId },
  ]);
  await page.evaluate(() => Promise.resolve());
  expect(fixture.requests).toEqual(before);
});

test('exact-record close refreshes only that selected record and unselected targets are ignored', async ({ page }) => {
  const fixture = await install(page);
  fixture.recordReplies.set(`${targetId}:status`, [{ status: 404 }, { status: 200, content: 'Closed status replacement.' }]);
  await page.goto(`/cards/${targetId}`);
  await expect(page.getByText('No status.md record yet.')).toBeVisible();
  const before = fixture.requests.length;
  await page.evaluate((frame) => window.__saivageWsFixture?.emit(frame), { t: 'invalidate', resource: 'cards', scope: 'record', card_id: sourceId, record_name: 'review.md' });
  await page.evaluate(() => Promise.resolve());
  expect(fixture.requests).toHaveLength(before);
  await page.evaluate((frame) => window.__saivageWsFixture?.emit(frame), { t: 'invalidate', resource: 'cards', scope: 'record', card_id: targetId, record_name: 'status.md' });
  await expect(page.getByText('Closed status replacement.')).toBeVisible();
  expect(fixture.requests.filter((entry) => entry === `GET /api/cards/${targetId}/records/review.md`)).toHaveLength(1);
});
