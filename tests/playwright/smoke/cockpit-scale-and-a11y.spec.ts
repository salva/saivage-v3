import { expect, test, type Page, type Route } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { cardRecords, installOperatorRestRoutes, smokeServerAvailability } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

const token = 'synthetic-cockpit-scale-token';
const now = '2026-09-24T12:00:00.000Z';

function segment(index: number): string {
  let value = index;
  let output = '';
  while (value > 0) { value -= 1; output = String.fromCharCode(97 + (value % 26)) + output; value = Math.floor(value / 26); }
  return output;
}

const CHAIN_DEPTH = 10;
const WIDE_CHILDREN = 280;
const BULK_PARENTS = 20;
const BULK_CHILDREN = 60;

const chainIds = ['card-da'];
for (let level = 1; level < CHAIN_DEPTH; level += 1) chainIds.push(`${chainIds[level - 1]}-a`);
const deepLeafId = chainIds[CHAIN_DEPTH - 1]!;
const wideId = 'card-w';
const wideChildIds = Array.from({ length: WIDE_CHILDREN }, (_, index) => `card-w-${segment(index + 1)}`);
const bulkParentIds = Array.from({ length: BULK_PARENTS }, (_, index) => `card-p${segment(index + 1)}`);
const bulkChildIds = bulkParentIds.flatMap((parent) => Array.from({ length: BULK_CHILDREN }, (_, index) => `${parent}-${segment(index + 1)}`));

function hierarchyEntry(id: string, title: string, status: string, permitted: boolean) {
  return { id, type: id === 'project' ? 'project' : id.startsWith('card-p') && bulkParentIds.includes(id) ? 'goal' : 'code', title, status, permitted_child_types: permitted ? ['code'] as const : [] as const };
}

const childrenByParent = new Map<string, Array<ReturnType<typeof hierarchyEntry>>>();
childrenByParent.set('project', [
  hierarchyEntry(chainIds[0]!, 'Deep chain root', 'backlog', true),
  hierarchyEntry(wideId, 'Wide sibling parent', 'backlog', true),
  ...bulkParentIds.map((id, index) => hierarchyEntry(id, `Bulk parent ${index + 1}`, 'backlog', true)),
]);
chainIds.forEach((id, level) => {
  childrenByParent.set(id, level < chainIds.length - 1
    ? [hierarchyEntry(chainIds[level + 1]!, level + 2 === CHAIN_DEPTH ? 'Deep leaf current work' : `Deep level ${level + 2}`, 'running', true)]
    : []);
});
childrenByParent.set(wideId, wideChildIds.map((id, index) => hierarchyEntry(id, `Wide child ${index + 1}`, 'backlog', false)));
bulkParentIds.forEach((parent, parentIndex) => {
  childrenByParent.set(parent, Array.from({ length: BULK_CHILDREN }, (_, index) => hierarchyEntry(`${parent}-${segment(index + 1)}`, `Bulk ${parentIndex + 1}.${index + 1}`, 'backlog', false)));
});

const totalCards = 1 + chainIds.length + 1 + wideChildIds.length + bulkParentIds.length + bulkChildIds.length;

function detailProjection(id: string, title: string) {
  return {
    id,
    type: id === 'project' ? 'project' : 'code',
    title,
    lifecycle: { status: id === deepLeafId ? 'running' : 'backlog', result: null, error: null, completed_at: null },
    urgency: 'normal',
    created_at: now,
    updated_at: now,
    allowedActions: [] as string[],
    version_seq: 1,
  };
}

const titles = new Map<string, string>();
for (const [parent, children] of childrenByParent) for (const child of children) titles.set(child.id, child.title);
titles.set('project', 'Scale fixture project');
titles.set(deepLeafId, 'Deep leaf current work');

async function json(route: Route, payload: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function installScaleFixture(page: Page): Promise<{ childrenReads: string[] }> {
  const childrenReads: string[] = [];
  await page.route('**/api/state', (route) => json(route, parseOperatorResponse('runtime.getState', 200, {
    projectId: 'project',
    runtime: { status: 'running', project_id: 'project', pid: 4242, started_at: now, current_card_id: deepLeafId, updated_at: now },
    serverAvailability: smokeServerAvailability,
  })));
  await page.route('**/api/runtime/status', (route) => json(route, parseOperatorResponse('runtime.status', 200, {
    runtime: 'running',
    currentCardId: deepLeafId,
    started_at: now,
    pid: 4242,
    actorRuntime: { pauseMode: 'running', cards: [{ cardId: deepLeafId, actorState: 'running', processState: { cardType: 'code', stateId: 'node:execute', kind: 'node', nodeId: 'execute', executionOrdinal: 0 } }] },
    oversight: { agent_name: 'oversight', session_id: 'agent:oversight:global', enabled: true, eligible: true, eligibility_reason: null, state: 'waiting', next_nominal_due: '2026-09-24T14:00:00.000Z', last_attempt: null, last_successful_at: null, service_epoch: now },
    restart_server_available: false,
    serverAvailability: smokeServerAvailability,
  })));
  await page.route('**/api/cards/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') return route.fallback();
    const childrenMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/children$/);
    if (childrenMatch) {
      const parentId = decodeURIComponent(childrenMatch[1]!);
      childrenReads.push(parentId);
      const children = childrenByParent.get(parentId);
      if (!children) return json(route, { error: 'Card not found', cardId: parentId }, 404);
      return json(route, parseOperatorResponse('cards.children', 200, {
        parent: hierarchyEntry(parentId, titles.get(parentId) ?? parentId, 'backlog', children.length > 0 || parentId === 'project'),
        children,
      }));
    }
    const agentSessionsMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/agent-sessions$/);
    if (agentSessionsMatch) {
      return json(route, parseOperatorResponse('agents.cardSessions', 200, { card_id: decodeURIComponent(agentSessionsMatch[1]!), sessions: [] }));
    }
    const recordsMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/records$/);
    if (recordsMatch) {
      return json(route, parseOperatorResponse('cards.records.list', 200, { card_id: decodeURIComponent(recordsMatch[1]!), records: cardRecords }));
    }
    const recordMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/records\/([^/]+)$/);
    if (recordMatch) {
      const cardId = decodeURIComponent(recordMatch[1]!);
      const name = decodeURIComponent(recordMatch[2]!);
      if (!cardRecords.some((descriptor) => descriptor.name === name)) return route.fallback();
      const content = name === 'brief.md' ? 'Exercise the synthetic scale fixture.' : 'Scale fixture work is in progress.';
      return json(route, parseOperatorResponse('cards.records.get', 200, {
        card_id: cardId,
        record: {
          name,
          head_version: 1,
          head_entry_id: '11111111-1111-4111-8111-111111111111',
          state: 'closed',
          accepted: {
            source_version: 1,
            source_entry_id: '11111111-1111-4111-8111-111111111111',
            committed_at: now,
            writer_agent: name === 'brief.md' ? 'runtime:bootstrap' : 'executor',
            card_version_seq: 1,
            content,
            content_sha256: 'a'.repeat(64),
            size_bytes: content.length,
          },
          draft: null,
          discarded: null,
          effective_content_source: 'accepted',
        },
      }));
    }
    const detailMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      return json(route, parseOperatorResponse('cards.get', 200, { card: detailProjection(id, titles.get(id) ?? id) }));
    }
    return route.fallback();
  });
  return { childrenReads };
}

test('cockpit orients and stays bounded on a 1,500+ card fixture with deep chain and wide siblings', async ({ page }) => {
  expect(totalCards).toBeGreaterThanOrEqual(1500);
  await page.addInitScript((value) => localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  const { childrenReads } = await installScaleFixture(page);

  await page.goto('/');
  await expect(page.getByTestId('card-flow-title')).toHaveText('Deep leaf current work');
  await expect(page.getByTestId('cockpit-inspecting')).toContainText('Inspecting Deep leaf current work');
  await expect(page.getByTestId('card-flow-position')).toContainText(/execute|Observed/i);

  await expect.poll(() => childrenReads).toEqual(expect.arrayContaining(['project', ...chainIds.slice(0, -1)]));
  expect(new Set(childrenReads).size).toBeLessThanOrEqual(CHAIN_DEPTH);
  for (const bulk of bulkParentIds.slice(0, 3)) expect(childrenReads).not.toContain(bulk);
  expect(childrenReads).not.toContain(wideId);

  const treeRows = page.locator('.tree-node');
  const cardTree = page.locator('aside[aria-label="Card tree"]');
  await expect(cardTree.getByRole('searchbox')).toHaveCount(0);
  await expect(treeRows.filter({ hasText: 'Deep leaf current work' })).toBeVisible();
  const treeScroller = page.locator('.cockpit-tree-scroll');
  await expect(treeScroller).toHaveJSProperty('isConnected', true);

  await page.getByRole('button', { name: 'Expand Wide sibling parent', exact: true }).click();
  await expect.poll(() => childrenReads).toContain(wideId);
  await expect(treeRows.filter({ hasText: 'Wide child 1' }).first()).toBeVisible();
  await expect.poll(async () => treeRows.filter({ hasText: /Wide child/ }).count()).toBeGreaterThanOrEqual(WIDE_CHILDREN);
  expect(await treeScroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(page.getByText(/descendants|total cards|1,\d{3}|completion/i)).toHaveCount(0);

  await page.getByRole('button', { name: 'Collapse Wide sibling parent', exact: true }).click();
  await expect(treeRows.filter({ hasText: /Wide child/ })).toHaveCount(0);
  await expect(treeRows.filter({ hasText: 'Deep leaf current work' })).toBeVisible();
  await expect(treeRows.filter({ has: page.locator('.node-title').filter({ hasText: /^Bulk parent 1$/ }) })).toBeVisible();

  await page.getByRole('button', { name: 'Expand Wide sibling parent', exact: true }).click();
  await expect.poll(async () => treeRows.filter({ hasText: /Wide child/ }).count()).toBeGreaterThanOrEqual(WIDE_CHILDREN);
  expect(childrenReads.filter((id) => id === wideId)).toHaveLength(1);

  expect(rest.unknown).toEqual([]);
});

test('cockpit core journeys stay keyboard-reachable, named, non-color, and legible at doubled text size', async ({ page }) => {
  await page.addInitScript((value) => localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await installScaleFixture(page);

  await page.goto('/');
  await expect(page.getByTestId('card-flow-title')).toHaveText('Deep leaf current work');

  await expect(page.locator('nav[aria-label="Primary navigation"]')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Analyst chat' })).toBeVisible();
  await expect(page.locator('aside[aria-label="Card tree"]')).toBeVisible();
  await expect(page.locator('nav[aria-label="Card facets"]')).toBeVisible();

  const selectedRow = page.locator('.tree-node[aria-current="true"]');
  await expect(selectedRow).toContainText('Deep leaf current work');
  await expect(page.locator('.card-flow-header .status-badge')).toContainText('running');

  const composer = page.getByRole('textbox', { name: 'Analyst chat composer' });
  await page.keyboard.press('/');
  await expect(composer).toBeFocused();

  const stopButton = page.getByTestId('strip-stop');
  await expect(stopButton).toBeVisible();
  const reached: string[] = [];
  await composer.blur();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press('Tab');
    const descriptor = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element) return '';
      return [element.dataset.testid, element.getAttribute('aria-label'), element.tagName.toLowerCase(), element.id].filter(Boolean).join('|');
    });
    reached.push(descriptor);
  }
  expect(reached.some((entry) => entry.includes('strip-stop'))).toBe(true);
  expect(reached.some((entry) => entry === 'button' || /Expand|Collapse/.test(entry))).toBe(true);

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expect(page.getByTestId('card-flow-title')).toBeVisible();
  await expect(page.getByTestId('strip-project')).toBeVisible();
  await expect.poll(async () => page.getByRole('region', { name: 'Analyst chat' }).evaluate((el, viewportHeight) => el.getBoundingClientRect().height <= viewportHeight, await page.evaluate(() => window.innerHeight))).toBe(true);

  expect(rest.unknown).toEqual([]);
});
