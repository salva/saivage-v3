import { expect, test, type Page, type Route } from '@playwright/test';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const token = 'synthetic-cards-scroll-token';
const now = '2026-07-17T12:00:00.000Z';
const sourceId = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const goalId = 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const targetId = 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb-cccccccccccccccccccccccccccc';

function card(overrides: Record<string, unknown>) {
  const status = String(overrides.status ?? 'backlog');
  const terminal = ['done', 'failed', 'cancelled'].includes(status);
  const lifecycle = status === 'blocked'
    ? { status, result: { kind: 'blocked', summary: 'Synthetic deterministic blocker.' }, error: 'Synthetic deterministic blocker.', completed_at: null }
    : status === 'done'
      ? { status, result: { kind: 'done', summary: 'Synthetic deterministic completion.' }, error: null, completed_at: now }
      : status === 'failed'
        ? { status, result: { kind: 'failed', summary: 'Synthetic deterministic failure.' }, error: 'Synthetic deterministic failure.', completed_at: now }
        : { status, result: null, error: null, completed_at: status === 'cancelled' ? now : null };
  return {
    id: sourceId,
    type: 'code',
    parent: 'project',
    depth: 1,
    position: 1,
    children: [],
    title: 'Source card with canonical record link',
    description: 'Deterministic Cards browser fixture.',
    status,
    lifecycle,
    logical_path: '1',
    operator_summary: {
      lifecycleStatus: status,
      terminal,
      blocked: status === 'blocked',
      hasError: status === 'failed',
      error: null,
      completedAt: terminal ? now : null,
      stale: false,
      actionCount: 0,
    },
    tags: [],
    priority: 50,
    urgency: 'normal',
    created_by: 'user',
    created_at: now,
    updated_at: now,
    depends_on: [],
    related: [],
    pending_notifications: [],
    version_seq: 1,
    ...overrides,
  };
}

const source = card({ status: 'running' });
const goal = card({ id: goalId, type: 'goal', position: 2, children: [targetId], title: 'Collapsed ancestor goal', status: 'backlog', logical_path: '2' });
const target = card({ id: targetId, parent: goalId, depth: 2, position: 1, title: 'Deep linked target', status: 'blocked', logical_path: '2.1' });
function segment(value: number): string {
  const letters = Array<string>(28).fill('a');
  let remaining = value;
  for (let index = letters.length - 1; index >= 0 && remaining > 0; index -= 1) {
    letters[index] = String.fromCharCode(97 + (remaining % 26));
    remaining = Math.floor(remaining / 26);
  }
  return letters.join('');
}
const overflowCards = Array.from({ length: 32 }, (_, index) => card({
  id: `card-${segment(index + 3)}`,
  position: index + 3,
  title: `Overflow tree card ${String(index + 1).padStart(2, '0')}`,
  logical_path: String(index + 3),
}));
const project = card({
  id: 'project',
  type: 'project',
  parent: null,
  depth: 0,
  position: 0,
  children: [sourceId, goalId, ...overflowCards.map((entry) => entry.id)],
  title: 'Cards fixture project',
  status: 'running',
  lifecycle: { status: 'running', result: null, error: null, completed_at: null },
  logical_path: null,
  operator_summary: { lifecycleStatus: 'running', terminal: false, blocked: false, hasError: false, error: null, completedAt: null, stale: false, actionCount: 0 },
});
const initialCards = [project, source, goal, target, ...overflowCards];
const replacementTarget = card({
  ...target,
  title: 'Deep linked target after canonical refresh',
  status: 'changed',
  lifecycle: { status: 'changed', result: null, error: null, completed_at: null },
  operator_summary: { lifecycleStatus: 'changed', terminal: false, blocked: false, hasError: false, error: null, completedAt: null, stale: false, actionCount: 0 },
  version_seq: 2,
});

type CardsFixture = {
  cardsRequestCount: number;
  detailRequestCounts: Record<string, number>;
  useReplacement: boolean;
  holdNextDetail: (id: string, outcome: 'success' | 'failure') => void;
  releaseDetail: (id: string) => void;
};

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function installCardsFixture(page: Page, authBanner: boolean): Promise<CardsFixture> {
  await page.addInitScript((value) => window.localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page);
  await installOperatorRestRoutes(page, {
    unauthorized: authBanner ? (method, pathname) => method === 'GET' && pathname === '/api/state' : false,
  });

  const heldDetails = new Map<string, { outcome: 'success' | 'failure'; promise: Promise<void>; release: () => void }>();
  const fixture: CardsFixture = {
    cardsRequestCount: 0,
    detailRequestCounts: {},
    useReplacement: false,
    holdNextDetail(id, outcome) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      heldDetails.set(id, { outcome, promise, release });
    },
    releaseDetail(id) {
      const held = heldDetails.get(id);
      if (!held) throw new Error(`No held detail request for ${id}`);
      held.release();
    },
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/cards') {
      fixture.cardsRequestCount += 1;
      const cards = fixture.useReplacement
        ? initialCards.map((entry) => entry.id === targetId ? replacementTarget : entry)
        : initialCards;
      await fulfillJson(route, parseOperatorResponse('cards.list', { cards, total: cards.length }));
      return;
    }

    const detailMatch = request.method() === 'GET' ? url.pathname.match(/^\/api\/cards\/([^/]+)$/) : null;
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      fixture.detailRequestCounts[id] = (fixture.detailRequestCounts[id] ?? 0) + 1;
      const held = heldDetails.get(id);
      if (held) {
        await held.promise;
        heldDetails.delete(id);
        if (held.outcome === 'failure') {
          await fulfillJson(route, { error: 'unavailable', message: 'Synthetic delayed detail failure' }, 503);
          return;
        }
      }
      const cards = fixture.useReplacement
        ? initialCards.map((entry) => entry.id === targetId ? replacementTarget : entry)
        : initialCards;
      const detailCard = cards.find((entry) => entry.id === id);
      if (!detailCard) {
        await fulfillJson(route, { error: 'not_found', message: 'Synthetic card not found' }, 404);
        return;
      }
      await fulfillJson(route, parseOperatorResponse('cards.get', { card: detailCard, children: cards.filter((entry) => entry.parent === id) }));
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/files/content') {
      const path = url.searchParams.get('path') ?? '';
      const recordUrl = new URL(path);
      const cardId = recordUrl.searchParams.get('card');
      const slot = recordUrl.pathname.split('/').at(-1);
      if (slot !== 'brief.md') {
        await fulfillJson(route, { error: 'not_found', message: 'No canonical record for this slot' }, 404);
        return;
      }
      const linkLine = cardId === sourceId ? `Open [[card:${targetId}|the deep linked target]].\n\n` : '';
      const content = `# Canonical brief\n\n${linkLine}${Array.from({ length: 90 }, (_, index) => `Detail overflow line ${index + 1}.`).join('\n\n')}`;
      await fulfillJson(route, parseOperatorResponse('files.content', {
        path,
        size: new TextEncoder().encode(content).length,
        contentType: 'text/markdown',
        content,
        redacted: false,
        sensitivity: 'normal',
        version: 1,
        modifiedAt: now,
      }));
      return;
    }

    await route.fallback();
  });
  return fixture;
}

function selectedRow(page: Page) {
  return page.locator('.tree-node[aria-current="true"]');
}

async function expectSelected(page: Page, title: string, status: string) {
  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page).locator('.node-title')).toHaveText(title);
  await expect(selectedRow(page).locator('.state-ball')).toHaveClass(new RegExp(`\\bcard-status-${status}\\b`));
}

async function expectIndependentDesktopScrolling(page: Page, bannerExpected: boolean) {
  const tree = page.locator('.cards-md__tree');
  const detail = page.locator('.card-detail-container');
  const routeHost = page.locator('.workspace-route-host');
  const workspace = page.locator('.workspace-content');
  await expect.poll(() => tree.evaluate((element) => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === 'auto')).toBe(true);
  await expect.poll(() => detail.evaluate((element) => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === 'auto')).toBe(true);

  const before = await page.evaluate(() => ({
    treeTop: document.querySelector('.cards-md__tree')!.getBoundingClientRect().top,
    detailTop: document.querySelector('.card-detail-container')!.getBoundingClientRect().top,
    routeTop: document.querySelector('.workspace-route-host')!.getBoundingClientRect().top,
    workspaceTop: document.querySelector('.workspace-content')!.getBoundingClientRect().top,
    routeScroll: document.querySelector('.workspace-route-host')!.scrollTop,
    workspaceScroll: document.querySelector('.workspace-content')!.scrollTop,
    documentScroll: document.documentElement.scrollTop,
    bodyScroll: document.body.scrollTop,
  }));

  await tree.evaluate((element) => { element.scrollTop = 160; });
  await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await detail.evaluate((element) => element.scrollTop)).toBe(0);
  const treeScroll = await tree.evaluate((element) => element.scrollTop);
  await detail.evaluate((element) => { element.scrollTop = 220; });
  await expect.poll(() => detail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await tree.evaluate((element) => element.scrollTop)).toBe(treeScroll);

  const after = await page.evaluate(() => ({
    treeTop: document.querySelector('.cards-md__tree')!.getBoundingClientRect().top,
    detailTop: document.querySelector('.card-detail-container')!.getBoundingClientRect().top,
    routeTop: document.querySelector('.workspace-route-host')!.getBoundingClientRect().top,
    workspaceTop: document.querySelector('.workspace-content')!.getBoundingClientRect().top,
    routeScroll: document.querySelector('.workspace-route-host')!.scrollTop,
    workspaceScroll: document.querySelector('.workspace-content')!.scrollTop,
    documentScroll: document.documentElement.scrollTop,
    bodyScroll: document.body.scrollTop,
  }));
  expect(after).toEqual(before);

  if (bannerExpected) {
    const banner = page.getByTestId('api-auth-banner');
    await expect(banner).toBeVisible();
    const [bannerBox, routeBox, workspaceBox] = await Promise.all([banner.boundingBox(), routeHost.boundingBox(), workspace.boundingBox()]);
    expect(bannerBox).not.toBeNull();
    expect(routeBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(routeBox!.y).toBeCloseTo(bannerBox!.y + bannerBox!.height, 0);
    expect(routeBox!.height).toBeLessThan(workspaceBox!.height);
  } else {
    await expect(page.getByTestId('api-auth-banner')).toHaveCount(0);
  }
}

test('desktop Cards uses independent panes and route-only semantic selection through real navigation and refresh', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await installCardsFixture(page, false);
  await page.goto(`/cards/${targetId}`);

  await expect(page.getByTestId('route-cards')).toBeVisible();
  await expectSelected(page, 'Deep linked target', 'blocked');
  await expect(page.getByRole('button', { name: 'Collapsed ancestor goal: Expanded to show selected card', exact: true })).toBeVisible();
  await expect(page.locator('.tree-node').filter({ hasText: 'Deep linked target' })).toBeVisible();
  await expect(page.getByPlaceholder(/search cards/i)).toHaveCount(0);
  await expect(page.getByText(/Any status|Any type|Clear filters/i)).toHaveCount(0);
  await expectIndependentDesktopScrolling(page, false);

  await page.locator('.tree-node').filter({ hasText: 'Source card with canonical record link' }).click();
  await expect(page).toHaveURL(`/cards/${sourceId}`);
  await expectSelected(page, 'Source card with canonical record link', 'running');
  await page.goBack();
  await expect(page).toHaveURL(`/cards/${targetId}`);
  await expectSelected(page, 'Deep linked target', 'blocked');
  await page.goForward();
  await expect(page).toHaveURL(`/cards/${sourceId}`);
  await expectSelected(page, 'Source card with canonical record link', 'running');

  const recordLink = page.getByRole('link', { name: 'the deep linked target' });
  await expect(recordLink).toHaveAttribute('href', `/cards/${encodeURIComponent(targetId)}`);
  await recordLink.click();
  await expect(page).toHaveURL(`/cards/${targetId}`);
  await expectSelected(page, 'Deep linked target', 'blocked');
  await expect(page.getByRole('button', { name: 'Collapsed ancestor goal: Expanded to show selected card', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`/cards/${sourceId}`);
  await expectSelected(page, 'Source card with canonical record link', 'running');
  await expect(page.getByRole('link', { name: 'the deep linked target' })).toHaveAttribute('href', `/cards/${targetId}`);
  await page.goForward();
  await expect(page).toHaveURL(`/cards/${targetId}`);
  await expectSelected(page, 'Deep linked target', 'blocked');

  const requestCount = fixture.cardsRequestCount;
  fixture.useReplacement = true;
  await page.evaluate(() => window.__saivageWsFixture!.emitCardChanged());
  await expect.poll(() => fixture.cardsRequestCount).toBeGreaterThan(requestCount);
  await expect(page).toHaveURL(`/cards/${targetId}`);
  await expectSelected(page, 'Deep linked target after canonical refresh', 'changed');
});

test('desktop Cards keeps independent pane geometry below the in-flow auth banner', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installCardsFixture(page, true);
  await page.goto(`/cards/${targetId}`);

  await expectSelected(page, 'Deep linked target', 'blocked');
  await expectIndependentDesktopScrolling(page, true);
});

test('desktop Cards preserves the mounted tree and scroll while selected detail is delayed or fails', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await installCardsFixture(page, false);
  await page.goto(`/cards/${sourceId}`);
  await expectSelected(page, 'Source card with canonical record link', 'running');

  const treeScroller = page.locator('.cards-md__tree');
  const treeRoot = page.locator('.tree-container');
  const successCard = overflowCards[25];
  const failureCard = overflowCards[26];
  const successId = String(successCard.id);
  const successTitle = String(successCard.title);
  const failureId = String(failureCard.id);
  const failureTitle = String(failureCard.title);
  const successRow = page.locator('.tree-node').filter({ hasText: successTitle });
  await successRow.scrollIntoViewIfNeeded();
  await expect.poll(() => treeScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await treeRoot.evaluate((element) => { element.setAttribute('data-regression-tree-identity', 'original-tree'); });

  const collectionRequestCount = fixture.cardsRequestCount;
  const successScrollTop = await treeScroller.evaluate((element) => element.scrollTop);
  fixture.holdNextDetail(successId, 'success');
  await successRow.evaluate((element) => (element as HTMLElement).click());
  await expect.poll(() => fixture.detailRequestCounts[successId] ?? 0).toBe(1);

  await expect(page).toHaveURL(`/cards/${successId}`);
  await expectSelected(page, successTitle, 'backlog');
  await expect(page.getByText('Loading card', { exact: true })).toBeVisible();
  await expect(treeRoot).toHaveAttribute('data-regression-tree-identity', 'original-tree');
  expect(await treeScroller.evaluate((element) => element.scrollTop)).toBe(successScrollTop);
  expect(fixture.cardsRequestCount).toBe(collectionRequestCount);

  fixture.releaseDetail(successId);
  await expect(page.getByTestId('card-detail-highlight')).toContainText(successTitle);
  await expect(treeRoot).toHaveAttribute('data-regression-tree-identity', 'original-tree');
  expect(await treeScroller.evaluate((element) => element.scrollTop)).toBe(successScrollTop);
  expect(fixture.cardsRequestCount).toBe(collectionRequestCount);

  const failureRow = page.locator('.tree-node').filter({ hasText: failureTitle });
  await failureRow.scrollIntoViewIfNeeded();
  const failureScrollTop = await treeScroller.evaluate((element) => element.scrollTop);
  fixture.holdNextDetail(failureId, 'failure');
  await failureRow.evaluate((element) => (element as HTMLElement).click());
  await expect.poll(() => fixture.detailRequestCounts[failureId] ?? 0).toBe(1);
  await expect(page).toHaveURL(`/cards/${failureId}`);
  await expectSelected(page, failureTitle, 'backlog');
  await expect(page.getByText('Loading card', { exact: true })).toBeVisible();
  await expect(treeRoot).toHaveAttribute('data-regression-tree-identity', 'original-tree');
  expect(await treeScroller.evaluate((element) => element.scrollTop)).toBe(failureScrollTop);

  fixture.releaseDetail(failureId);
  await expect(page.getByText('Card detail unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Could not load cards', { exact: true })).toHaveCount(0);
  await expect(treeRoot).toHaveAttribute('data-regression-tree-identity', 'original-tree');
  expect(await treeScroller.evaluate((element) => element.scrollTop)).toBe(failureScrollTop);
  expect(fixture.cardsRequestCount).toBe(collectionRequestCount);
});

test('mobile Cards uses a single pane, scrollable detail, and Back to Cards', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 720 });
  await installCardsFixture(page, false);
  await page.goto('/cards');

  const list = page.locator('.entity-inspector-shell__list');
  const detailPane = page.locator('.entity-inspector-shell__detail');
  await expect(list).toBeVisible();
  await expect(detailPane).toBeHidden();
  await page.locator('.tree-node').filter({ hasText: 'Source card with canonical record link' }).click();
  await expect(page).toHaveURL(`/cards/${sourceId}`);
  await expect(list).toBeHidden();
  await expect(detailPane).toBeVisible();

  const detail = page.locator('.card-detail-container');
  await expect.poll(() => detail.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await detail.evaluate((element) => { element.scrollTop = 240; });
  await expect.poll(() => detail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Back to Cards' }).click();
  await expect(page).toHaveURL('/cards');
  await expect(list).toBeVisible();
  await expect(detailPane).toBeHidden();
});
