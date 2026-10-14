import { expect, test, type Page, type Route } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeCardId, smokeOperatorCard, smokeServerAvailability } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const now = '2026-10-14T12:00:00.000Z';
type Reply = { status: number; body: unknown };
function cardReply(id: string, error: string | null): Reply {
  return { status: 200, body: parseOperatorResponse('cards.get', 200, { card: {
    ...smokeOperatorCard, id, title: `Orientation ${id}`,
    lifecycle: error === null
      ? { status: 'running', result: null, error: null, completed_at: null }
      : { status: 'failed', result: { kind: 'runtime-failure', summary: error }, error, completed_at: now },
  } }) };
}
function failureReply(status: 404 | 500): Reply {
  const body = status === 404 ? { error: 'Card not found', cardId: 'card-b' }
    : { error: 'InternalServerError', message: 'Internal server error' };
  return { status, body: parseOperatorResponse('cards.get', status, body) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
async function json(route: Route, reply: Reply) {
  await route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
}

async function fixture(page: Page) {
  await page.addInitScript(() => localStorage.setItem('saivage_api_token', 'synthetic-orientation-token'));
  await installOperatorWebSocketShim(page);
  const base = await installOperatorRestRoutes(page);
  let current: string | null = 'card-a';
  const reads: string[] = [];
  const aborted: string[] = [];
  const queued = new Map<string, Array<{ reply: Promise<Reply>; complete: () => void }>>();
  page.on('requestfailed', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/cards/card-a' || path === '/api/cards/card-b') aborted.push(path);
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fallback();
    if (path === '/api/state') return json(route, { status: 200, body: parseOperatorResponse('runtime.getState', 200, {
      projectId: 'project', runtime: current === null ? null : { status: 'running', project_id: 'project', pid: 4242, started_at: now, current_card_id: current, updated_at: now }, serverAvailability: smokeServerAvailability,
    }) });
    if (path === '/api/runtime/status') return json(route, { status: 200, body: parseOperatorResponse('runtime.status', 200, {
      runtime: current ? 'running' : 'stopped', currentCardId: current, started_at: now, pid: 4242,
      actorRuntime: { pauseMode: current ? 'running' : 'idle', cards: current ? [{ cardId: current, actorState: 'running', processState: { cardType: 'code', stateId: 'node:execute', kind: 'node', nodeId: 'execute', executionOrdinal: 1 } }] : [] },
      oversight: { agent_name: 'oversight', session_id: 'agent:oversight:global', enabled: false, eligible: false, eligibility_reason: 'disabled', state: 'unavailable', next_nominal_due: null, last_attempt: null, last_successful_at: null, service_epoch: now },
      restart_server_available: false, serverAvailability: smokeServerAvailability,
    }) });
    if (path === '/api/cards/card-a' || path === '/api/cards/card-b') {
      const id = path.split('/').at(-1)!;
      reads.push(id);
      const held = queued.get(id)?.shift();
      await json(route, held ? await held.reply : cardReply(id, `${id} problem`));
      held?.complete();
      return;
    }
    return route.fallback();
  });
  function hold(id: string) {
    const held = deferred<Reply>();
    const completed = deferred<void>();
    const queue = queued.get(id) ?? [];
    queue.push({ reply: held.promise, complete: () => completed.resolve() }); queued.set(id, queue);
    return async (reply: Reply) => { held.resolve(reply); await completed.promise; };
  }
  async function observe(id: string | null) {
    current = id;
    await page.evaluate(() => window.__saivageWsFixture!.emitRuntimeUpdate());
    await expect(page.getByTestId('strip-current-work')).toHaveText(id ?? 'No current work');
  }
  return { base, reads, aborted, hold, observe };
}

test('production shell distinguishes current runtime identity from retained detail through acquisition, failure and return', async ({ page }, testInfo) => {
  const f = await fixture(page);
  // C is the real selected cockpit resource; orientation A is acquired independently.
  await page.goto(`/cards/${smokeCardId}`);
  await expect(page.getByTestId('card-flow-title')).toHaveText(smokeOperatorCard.title);
  await expect(page.getByLabel('Analyst chat composer')).toBeVisible();
  await expect(page.getByTestId('strip-socket')).toHaveText('Connected');
  const strip = page.getByTestId('global-strip');
  const notices = strip.locator('.strip-problem');
  await expect(page.getByTestId('strip-current-work')).toHaveText('card-a');
  await expect(notices).toHaveText(['Current card card-a: card-a problem']);
  expect(f.reads).toEqual(['card-a']);

  const releaseB = f.hold('card-b');
  await f.observe('card-b');
  await expect(notices).toHaveText(['Current card card-b details loading.', 'Last-known card card-a: card-a problem']);
  await expect.poll(() => f.reads).toEqual(['card-a', 'card-b']);
  await page.screenshot({ path: testInfo.outputPath('b-loading-retained-a.png') });
  await releaseB(cardReply('card-b', 'new B problem'));
  await expect(notices).toHaveText(['Current card card-b: new B problem']);

  await f.observe('card-a');
  await expect(notices).toHaveText(['Current card card-a: card-a problem']);
  expect(f.reads.filter((id) => id === 'card-a')).toHaveLength(2);
  const failedB = f.hold('card-b');
  await f.observe('card-b');
  await expect(notices).toHaveText(['Current card card-b details loading.', 'Last-known card card-a: card-a problem']);
  await failedB(failureReply(500));
  await expect(notices).toHaveText(['Current card card-b details could not be loaded.', 'Last-known card card-a: card-a problem']);
  await page.screenshot({ path: testInfo.outputPath('b-failed-retained-a.png') });

  const returnedA = f.hold('card-a');
  await f.observe('card-a');
  await expect(notices).toHaveText(['Current card card-a details loading.', 'Last-known card card-a: card-a problem']);
  await returnedA(cardReply('card-a', 'refreshed A problem'));
  await expect(notices).toHaveText(['Current card card-a: refreshed A problem']);
  const missingB = f.hold('card-b');
  await f.observe('card-b');
  await missingB(failureReply(404));
  await expect(notices).toHaveText(['Current card card-b details unavailable (card not found).', 'Last-known card card-a: refreshed A problem']);
  await expect(page.getByTestId('strip-current-work')).toHaveText('card-b');
  await page.screenshot({ path: testInfo.outputPath('b-not-found-retained-a.png') });

  await f.observe(null);
  await expect(notices).toHaveText(['No live runtime.', 'Last-known card card-a: refreshed A problem']);
  const pendingA = f.hold('card-a');
  await f.observe('card-a');
  await expect(notices).toHaveText(['Current card card-a details loading.', 'Last-known card card-a: refreshed A problem']);
  await expect.poll(() => f.reads.filter((id) => id === 'card-a').length).toBe(4);
  await f.observe(null);
  await expect(notices).toHaveText(['No live runtime.', 'Last-known card card-a: refreshed A problem']);
  await expect.poll(() => f.aborted).toContain('/api/cards/card-a');
  // Chromium cancelled this fetch; this does not claim delivery of its late callback.
  await pendingA(cardReply('card-a', 'departed A body'));
  await expect(notices).toHaveText(['No live runtime.', 'Last-known card card-a: refreshed A problem']);
  await expect(page.getByTestId('strip-current-work')).toHaveText('No current work');

  const finalA = f.hold('card-a');
  await f.observe('card-a');
  await expect(notices).toHaveText(['Current card card-a details loading.', 'Last-known card card-a: refreshed A problem']);
  await expect.poll(() => f.reads.filter((id) => id === 'card-a').length).toBe(5);
  await finalA(cardReply('card-a', null));
  await expect(notices).toHaveCount(0);
  await expect(page.getByTestId('card-flow-title')).toHaveText(smokeOperatorCard.title);
  await page.screenshot({ path: testInfo.outputPath('healthy-a-selected-c.png') });
  expect(f.base.unknown).toEqual([]);
});

test('production cancellation prevents a pending B from changing returned A or accepted null', async ({ page }, testInfo) => {
  const f = await fixture(page);
  await page.goto(`/cards/${smokeCardId}`);
  const notices = page.getByTestId('global-strip').locator('.strip-problem');
  await expect(notices).toHaveText(['Current card card-a: card-a problem']);
  await expect(page.getByTestId('strip-socket')).toHaveText('Connected');
  const b = f.hold('card-b');
  await f.observe('card-b');
  await expect(notices).toHaveText(['Current card card-b details loading.', 'Last-known card card-a: card-a problem']);
  await expect.poll(() => f.reads).toEqual(['card-a', 'card-b']);
  const a = f.hold('card-a');
  await f.observe('card-a');
  await expect(notices).toHaveText(['Current card card-a details loading.', 'Last-known card card-a: card-a problem']);
  await expect.poll(() => f.aborted).toContain('/api/cards/card-b');
  await b(failureReply(404));
  await expect(notices).toHaveText(['Current card card-a details loading.', 'Last-known card card-a: card-a problem']);
  await a(cardReply('card-a', 'returned A problem'));
  await expect(notices).toHaveText(['Current card card-a: returned A problem']);
  const b2 = f.hold('card-b');
  await f.observe('card-b');
  await expect(notices).toHaveText(['Current card card-b details loading.', 'Last-known card card-a: returned A problem']);
  await expect.poll(() => f.reads).toEqual(['card-a', 'card-b', 'card-a', 'card-b']);
  await f.observe(null);
  await expect.poll(() => f.aborted.filter((path) => path === '/api/cards/card-b').length).toBe(2);
  await b2(cardReply('card-b', 'departed B problem'));
  await expect(notices).toHaveText(['No live runtime.', 'Last-known card card-a: returned A problem']);
  await expect(page.getByTestId('strip-current-work')).toHaveText('No current work');
  expect(f.reads).toEqual(['card-a', 'card-b', 'card-a', 'card-b']);
  await page.screenshot({ path: testInfo.outputPath('null-retained-a-cancelled-b.png') });
  expect(f.base.unknown).toEqual([]);
});
