import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeServerAvailability } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const token = 'synthetic-card-status-token';
const now = '2026-07-24T12:00:00.000Z';
const goalId = 'card-a';
const stoppedId = 'card-a-a';
const runningId = 'card-a-b';
const doneId = 'card-a-c';
const cancelledId = 'card-a-d';
const childTitles = ['Stopped child', 'Running child', 'Done child', 'Cancelled child'];

type FixtureStatus = 'running' | 'stopped' | 'done' | 'cancelled';

function card(id: string, title: string, status: FixtureStatus, children: string[] = []) {
  const completed = status === 'done' ? now : null;
  return {
    id,
    type: id === 'project' ? 'project' : id === goalId ? 'goal' : 'code',
    children,
    title,
    subtype: null,
    lifecycle: {
      status,
      result: status === 'done' ? { kind: 'workflow-result', terminal: 'DONE', agent_name: 'executor', node_id: 'execute', outcome: 'done', summary: 'Done fixture', records: [] } : null,
      error: null,
      completed_at: completed,
    },
    operator_summary: { blocked: false, hasError: false, error: null, completedAt: completed, stale: false },
    tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now,
    assigned_to: null, depends_on: [], related: [], metrics: null, estimate: null, started_at: null, duration_ms: null,
    status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null,
    pending_notifications: [], allowedActions: [], version_seq: 1,
  };
}

const children = [
  card(stoppedId, childTitles[0]!, 'stopped'),
  card(runningId, childTitles[1]!, 'running'),
  card(doneId, childTitles[2]!, 'done'),
  card(cancelledId, childTitles[3]!, 'cancelled'),
];
const goal = card(goalId, 'Representative status goal', 'running', children.map((child) => child.id));
const project = card('project', 'Status fixture project', 'running', [goalId]);
const hierarchy=(value:ReturnType<typeof card>)=>({id:value.id,type:value.type,title:value.title,status:value.lifecycle.status,permitted_child_types:value.type==='project'||value.type==='goal'?['code'] as const:[]});
const detailProjection=(value:ReturnType<typeof card>)=>({id:value.id,type:value.type,title:value.title,lifecycle:value.lifecycle,version_seq:value.version_seq,urgency:value.urgency,created_at:value.created_at,updated_at:value.updated_at,allowedActions:value.allowedActions});
const descriptors=[{name:'brief.md',format:'markdown' as const,schema:'brief.v1',writers:['analyst'],bootstrap:true,current:null}];

async function json(route: Route, payload: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function install(page: Page): Promise<string[]> {
  await page.addInitScript((value) => localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page);
  await installOperatorRestRoutes(page);
  const requests: string[] = [];

  await page.route('**/api/state', (route) => json(route, parseOperatorResponse('runtime.getState', 200, {
    projectRoot: '/work/status-fixture',
    projectId: 'project',
    runtime: { status: 'running', project_id: 'project', pid: 4242, started_at: now, current_card_id: goalId, updated_at: now },
    serverAvailability: smokeServerAvailability,
  })));
  await page.route('**/api/runtime/status', (route) => json(route, parseOperatorResponse('runtime.status', 200, {
    runtime: 'running', currentCardId: goalId, started_at: now, pid: 4242,
    actorRuntime: { pauseMode: 'running', cards: [{ cardId: goalId, actorState: 'running', processState: { cardType: 'goal', stateId: 'node:plan', kind: 'node', nodeId: 'plan', executionOrdinal: 0 } }] },
    restart_server_available: false,
    serverAvailability: smokeServerAvailability,
  })));
  await page.route('**/api/cards**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
    if (request.method() !== 'GET') return route.fallback();
    if (url.pathname === '/api/cards/project/children') {
      return json(route, parseOperatorResponse('cards.children', 200, { parent: hierarchy(project), children: [hierarchy(goal)] }));
    }
    if (url.pathname === `/api/cards/${goalId}/children`) {
      return json(route, parseOperatorResponse('cards.children', 200, { parent: hierarchy(goal), children: children.map(hierarchy) }));
    }
    const recordsId=url.pathname.match(/^\/api\/cards\/([^/]+)\/records$/)?.[1];
    if(recordsId)return json(route,parseOperatorResponse('cards.records.list',200,{card_id:decodeURIComponent(recordsId),records:descriptors}));
    const recordMatch=url.pathname.match(/^\/api\/cards\/([^/]+)\/records\/([^/]+)$/);
    if(recordMatch)return json(route,parseOperatorResponse('cards.records.get',200,{card_id:decodeURIComponent(recordMatch[1]!),record:{name:decodeURIComponent(recordMatch[2]!),head_version:1,head_entry_id:'11111111-1111-4111-8111-111111111111',state:'closed',accepted:{source_version:1,source_entry_id:'11111111-1111-4111-8111-111111111111',committed_at:now,writer_agent:'runtime:bootstrap',card_version_seq:1,content:'Brief',content_sha256:'a'.repeat(64),size_bytes:5},draft:null,discarded:null,effective_content_source:'accepted'}}));
    const detailId = url.pathname.match(/^\/api\/cards\/([^/]+)$/)?.[1];
    if (detailId) {
      const detail = [project, goal, ...children].find((entry) => entry.id === decodeURIComponent(detailId));
      if (detail) return json(route, parseOperatorResponse('cards.get', 200, { card: detailProjection(detail) }));
    }
    return route.fallback();
  });
  return requests;
}

function treeRow(page: Page, title: string): Locator {
  return page.locator('.tree-node').filter({ has: page.locator('.node-title').filter({ hasText: new RegExp(`^${title}$`) }) });
}

function dashboardRow(page: Page, title: string): Locator {
  return page.getByTestId('child-of-goal-item').filter({ has: page.locator('.title').filter({ hasText: new RegExp(`^${title}$`) }) });
}

async function resolvedBackground(page: Page, value: string): Promise<string> {
  return page.evaluate((backgroundColor) => {
    const element = document.createElement('span');
    element.style.backgroundColor = backgroundColor;
    document.body.append(element);
    const resolved = getComputedStyle(element).backgroundColor;
    element.remove();
    return resolved;
  }, value);
}

async function expectPaintFits(marker: Locator, container: Locator): Promise<void> {
  const geometry = await marker.evaluate((element, parent) => {
    const markerRect = element.getBoundingClientRect();
    const containerRect = (parent as Element).getBoundingClientRect();
    return {
      fits: markerRect.left >= containerRect.left && markerRect.top >= containerRect.top
        && markerRect.right <= containerRect.right && markerRect.bottom <= containerRect.bottom,
      markerOverflow: getComputedStyle(element).overflow,
      containerOverflow: getComputedStyle(parent as Element).overflow,
    };
  }, await container.elementHandle());
  expect(geometry.fits).toBe(true);
  expect(geometry.markerOverflow).toBe('visible');
  expect(geometry.containerOverflow).toBe('visible');
}

test('stopped card presentation is purple and unringed across tree, detail, and Dashboard', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const requests = await install(page);
  await page.goto('/cards');
  await page.getByRole('button', { name: 'Expand Status fixture project', exact: true }).click();
  const goalResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === `/api/cards/${goalId}/children` && response.status() === 200;
  });
  await page.getByRole('button', { name: 'Expand Representative status goal', exact: true }).click();
  await goalResponse;

  expect(requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`)).toHaveLength(1);
  const representativeRows = page.locator('.tree-node').filter({ has: page.locator('.node-title').filter({ hasText: /^(Stopped|Running|Done|Cancelled) child$/ }) });
  await expect(representativeRows).toHaveCount(4);
  await expect(representativeRows.locator('.node-title')).toHaveText(childTitles);

  const expectedStopped = await resolvedBackground(page, 'var(--card-status-stopped)');
  const expectedRunning = await resolvedBackground(page, 'var(--card-status-running)');
  const expectedGray = await resolvedBackground(page, 'var(--card-status-cancelled)');
  const stoppedBall = treeRow(page, childTitles[0]!).locator('.state-ball');
  const runningBall = treeRow(page, childTitles[1]!).locator('.state-ball');
  const cancelledBall = treeRow(page, childTitles[3]!).locator('.state-ball');
  expect(expectedStopped).toBe('rgb(111, 66, 193)');
  expect(expectedRunning).toBe('rgb(22, 163, 74)');
  expect(expectedStopped).not.toBe(expectedRunning);
  await expect(stoppedBall).toHaveCSS('background-color', expectedStopped);
  await expect(runningBall).toHaveCSS('background-color', expectedRunning);
  await expect(cancelledBall).toHaveCSS('background-color', expectedGray);
  await expect(stoppedBall).toHaveCSS('box-shadow', 'none');
  await expect(runningBall).toHaveCSS('box-shadow', 'none');
  await expect(cancelledBall).toHaveCSS('box-shadow', 'none');
  for (const ball of [stoppedBall, runningBall, cancelledBall]) {
    const geometry = await ball.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, radius: getComputedStyle(element).borderRadius };
    });
    expect(geometry).toEqual({ width: 8, height: 8, radius: '999px' });
  }
  await expectPaintFits(stoppedBall, treeRow(page, childTitles[0]!));
  expect(await page.locator('.tree-container').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await treeRow(page, childTitles[0]!).click();
  await expect(page).toHaveURL(`/cards/${stoppedId}`);
  const detailBadge = page.getByTestId('card-detail-highlight').locator('.status-badge');
  const detailDot = detailBadge.locator('.status-badge__dot');
  await expect(detailBadge).toHaveClass(/tone-success/);
  await expect(detailDot).toHaveClass(/status-badge__dot--stopped/);
  await expect(detailDot).toHaveCSS('background-color', expectedStopped);
  await expect(detailDot).toHaveCSS('box-shadow', 'none');
  await expect(detailDot).toHaveCSS('width', '6px');
  await expect(detailDot).toHaveCSS('height', '6px');
  await expectPaintFits(detailDot, detailBadge);

  await page.locator('nav[aria-label="Primary navigation"] .nav-item-link').filter({ has: page.locator('.nav-label').filter({ hasText: /^Dashboard$/ }) }).click();
  await expect(page).toHaveURL('/dashboard');
  await expect(page.getByTestId('route-dashboard')).toBeVisible();
  expect(requests.filter((entry) => entry === `GET /api/cards/${goalId}/children`)).toHaveLength(1);

  const list = page.getByTestId('child-of-goal-list');
  await expect(list.getByTestId('child-of-goal-item').locator('.title')).toHaveText(childTitles);
  const stoppedBadge = dashboardRow(page, childTitles[0]!).locator('.status-badge');
  const stoppedDot = stoppedBadge.locator('.status-badge__dot');
  await expect(stoppedBadge).toHaveClass(/tone-success/);
  await expect(stoppedDot).toHaveClass(/status-badge__dot--stopped/);
  await expect(stoppedDot).toHaveCSS('background-color', expectedStopped);
  await expect(stoppedDot).toHaveCSS('box-shadow', 'none');
  for (const title of childTitles.slice(1)) await expect(dashboardRow(page, title).locator('.status-badge__dot')).toHaveCount(0);
  await expect(dashboardRow(page, childTitles[2]!).locator('.status-badge')).toHaveClass(/tone-success/);
  await expect(dashboardRow(page, childTitles[3]!).locator('.status-badge')).toHaveClass(/tone-neutral/);
  await expectPaintFits(stoppedDot, stoppedBadge);

  const badgeHeights = await list.locator('.status-badge').evaluateAll((badges) => badges.map((badge) => badge.getBoundingClientRect().height));
  expect(Math.max(...badgeHeights) - Math.min(...badgeHeights)).toBeLessThanOrEqual(1);
  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
