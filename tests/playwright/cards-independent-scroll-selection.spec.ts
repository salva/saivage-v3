import { expect, test, type Page, type Route } from '@playwright/test';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const token = 'synthetic-cards-scroll-token';
const now = '2026-07-17T12:00:00.000Z';
const sourceId = 'card-a';
const goalId = 'card-b';
const targetId = 'card-b-c';
const newId = 'card-b-d';

function card(id: string, title: string, children: string[] = [], status: 'backlog' | 'running' | 'blocked' = 'backlog') {
  return {
    id,
    type: id === 'project' ? 'project' : id === goalId ? 'goal' : 'code',
    parent: id === 'project' ? null : id.includes('-') && id.split('-').length > 2 ? goalId : 'project',
    depth: id === 'project' ? 0 : id.split('-').length - 1,
    children,
    title,
    status,
    lifecycle: { status, result: status === 'blocked' ? { kind: 'blocked', summary: 'blocked' } : null, error: status === 'blocked' ? 'blocked' : null, completed_at: null },
    operator_summary: { lifecycleStatus: status, terminal: false, blocked: status === 'blocked', hasError: false, error: null, completedAt: null, stale: false, actionCount: 0 },
    tags: [], priority: 0, urgency: 'normal', created_by: 'user', created_at: now, updated_at: now,
    depends_on: [], related: [], pending_notifications: [], allowedActions: [], version_seq: 1,
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
const target = card(targetId, 'Deep linked target', [], 'blocked');
const newlyLinked = card(newId, 'Current detail outside retained slice');
const project = card('project', 'Cards fixture project', [sourceId, goalId, ...overflow.map((entry) => entry.id)], 'running');

type Fixture = { requests: string[]; omitNewEdge: boolean; missingDetails: Set<string>; detailDelay: Map<string, Promise<void>>; hierarchyDelay: Map<string, Promise<void>> };
async function json(route: Route, payload: unknown, status = 200) { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) }); }

async function install(page: Page): Promise<Fixture> {
  await page.addInitScript((value) => localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page);
  await installOperatorRestRoutes(page);
  const fixture: Fixture = { requests: [], omitNewEdge: false, missingDetails: new Set(), detailDelay: new Map(), hierarchyDelay: new Map() };
  await page.route('**/api/cards**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    fixture.requests.push(`${request.method()} ${url.pathname}`);
    if (request.method() !== 'GET') return route.fallback();
    if (url.pathname === '/api/cards/project/children') {
      await fixture.hierarchyDelay.get('project');
      return json(route, parseOperatorResponse('cards.children', { card: project, children: [source, goal, ...overflow] }));
    }
    if (url.pathname === `/api/cards/${goalId}/children`) {
      const parent = fixture.omitNewEdge ? { ...goal, children: [targetId] } : goal;
      return json(route, parseOperatorResponse('cards.children', { card: parent, children: fixture.omitNewEdge ? [target] : [target, newlyLinked] }));
    }
    const childrenMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/children$/);
    if (childrenMatch) {
      const id = decodeURIComponent(childrenMatch[1]!);
      const found = [source, target, newlyLinked, ...overflow].find((entry) => entry.id === id);
      return found ? json(route, parseOperatorResponse('cards.children', { card: found, children: [] })) : json(route, { error: 'Card not found', cardId: id }, 404);
    }
    const detailMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      await fixture.detailDelay.get(id);
      if (fixture.missingDetails.has(id)) return json(route, { error: 'Card not found', cardId: id }, 404);
      const found = [project, source, goal, target, newlyLinked, ...overflow].find((entry) => entry.id === id);
      const detailCard = found && id === goalId ? { ...found, title: 'Detail authority goal' } : found;
      return detailCard ? json(route, parseOperatorResponse('cards.get', { card: detailCard })) : json(route, { error: 'Card not found', cardId: id }, 404);
    }
    return route.fallback();
  });
  await page.route('**/api/files/content**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '';
    if (!path.startsWith('record:///')) return route.fallback();
    if (path.startsWith('record:///brief.md') && path.includes(`card=${targetId}`)) {
      return json(route, { path, size: 48, contentType: 'text/markdown', content: `Continue with [[card:${sourceId}|Source card]].`, redacted: false, sensitivity: 'normal', version: 1, modifiedAt: now });
    }
    return json(route, { error: 'not_found', message: 'No optional record' }, 404);
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

test('detail 404 leaves represented hierarchy and successful slices unchanged', async ({ page }) => {
  const fixture = await install(page);
  fixture.missingDetails.add(targetId);
  await page.goto(`/cards/${targetId}`);
  await expect(selected(page)).toContainText('Deep linked target');
  await expect(page.locator('.status-banner__title')).toHaveText('Card not found');
  await expect(selected(page)).toContainText('Deep linked target');
  expect(fixture.requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`)).toHaveLength(1);
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
