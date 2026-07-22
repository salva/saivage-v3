import { expect, test, type Page, type Route } from '@playwright/test';
import { installOperatorRestRoutes, smokeCardId } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const token = 'synthetic-cards-bootstrap-order-token';
const analystSessionId = 'agent:analyst:global';
const linkedSessionId = `agent:executor:${smokeCardId}`;
const exactAnalystPath = '/api/chat';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function outboundConversationSubscribe(page: Page, sessionId: string) {
  return page.evaluate((id) => {
    const frames = (window.__saivageWsFixture?.outbound ?? []).map((frame) => JSON.parse(frame) as Record<string, unknown>);
    return frames.filter((frame) => frame.t === 'subscribe' && frame.resource === 'conversation' && frame.id === id).at(-1) ?? null;
  }, sessionId);
}

async function acknowledgeCurrentConversationLease(page: Page, sessionId: string, lease: string): Promise<void> {
  await page.evaluate(({ id, currentLease }) => window.__saivageWsFixture?.emit({
    t: 'subscribed',
    resource: 'conversation',
    id,
    lease: currentLease,
  }), { id: sessionId, currentLease: lease });
}

test('Cards root settlement precedes initial Agent and exact Analyst HTTP acquisition', async ({ page }) => {
  const rootRelease = deferred();
  const agentRelease = deferred();
  const rootObserved = deferred();
  const agentObserved = deferred();
  const requestLedger: string[] = [];
  const eventLedger: string[] = [];
  let rootReleased = false;
  let rootRequests = 0;
  let agentRequests = 0;
  let analystReads = 0;

  // Every transport and response control is installed before the real AppShell is navigated.
  await page.addInitScript((value) => window.localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET' && pathname === '/api/cards/project/children') {
      rootRequests += 1;
      requestLedger.push('cards:root');
      rootObserved.resolve();
      await rootRelease.promise;
      return route.fallback();
    }
    if (request.method() === 'GET' && pathname === '/api/agents') {
      if (!rootReleased) {
        await route.abort('failed');
        throw new Error(`GET /api/agents started before Cards root settlement: ${requestLedger.join(', ')}`);
      }
      agentRequests += 1;
      requestLedger.push('agents:list');
      if (agentRequests !== 1) {
        await route.abort('failed');
        throw new Error(`Expected exactly one held GET /api/agents, observed ${agentRequests}`);
      }
      agentObserved.resolve();
      await agentRelease.promise;
      return route.fallback();
    }
    if (request.method() === 'GET' && pathname === '/api/chats') {
      await route.abort('failed');
      throw new Error('Unexpected removed aggregate request GET /api/chats');
    }
    if (request.method() === 'GET' && pathname === exactAnalystPath) {
      if (!rootReleased) {
        await route.abort('failed');
        throw new Error(`Exact Analyst HTTP started before Cards root settlement: ${requestLedger.join(', ')}`);
      }
      analystReads += 1;
      requestLedger.push(`analyst:get:${analystReads}`);
    }
    return route.fallback();
  });

  await page.goto('/cards');
  await rootObserved.promise;
  await expect(page.getByText(/Live updates connected/i).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__saivageWsFixture?.sockets.length ?? 0)).toBe(1);
  expect(await outboundConversationSubscribe(page, analystSessionId)).toBeNull();
  expect(rootRequests).toBe(1);
  expect(rest.counts.get('GET /api/chats') ?? 0).toBe(0);
  expect(agentRequests).toBe(0);
  expect(analystReads).toBe(0);
  expect(requestLedger).toEqual(['cards:root']);

  rootReleased = true;
  eventLedger.push('cards:root:release');
  rootRelease.resolve();
  await expect(page.getByText('Synthetic Project', { exact: true })).toBeVisible();
  await agentObserved.promise;
  await expect.poll(() => analystReads).toBe(1);
  expect(agentRequests).toBe(1);
  expect(requestLedger[0]).toBe('cards:root');
  expect(requestLedger.slice(1).sort()).toEqual(['agents:list', 'analyst:get:1'].sort());

  await expect.poll(() => outboundConversationSubscribe(page, analystSessionId)).toMatchObject({
    t: 'subscribe',
    resource: 'conversation',
    id: analystSessionId,
  });
  const analystSubscribe = await outboundConversationSubscribe(page, analystSessionId) as { lease: string };
  eventLedger.push('analyst:subscribe');
  expect(analystSubscribe.lease).toMatch(/^[0-9a-f]{32}$/);

  eventLedger.push('analyst:ack:settled');
  await acknowledgeCurrentConversationLease(page, analystSessionId, analystSubscribe.lease);
  await expect.poll(() => analystReads).toBe(2);
  eventLedger.push('analyst:invalidate:settled');
  await page.evaluate((id) => window.__saivageWsFixture?.emit({ t: 'invalidate', resource: 'conversation', id }), analystSessionId);
  await expect.poll(() => analystReads).toBe(3);
  expect(eventLedger).toEqual([
    'cards:root:release',
    'analyst:subscribe',
    'analyst:ack:settled',
    'analyst:invalidate:settled',
  ]);

  agentRelease.resolve();
  await page.locator('.nav-item-link').filter({ hasText: 'Agents' }).click();
  await expect(page).toHaveURL('/agents');
  await expect(page.getByTestId('route-agents')).toContainText('synthetic-model');
  await expect(page.getByRole('button', { name: 'Synthetic dashboard smoke card', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Synthetic dashboard smoke card', exact: true }).click();
  await expect(page).toHaveURL(`/cards/${smokeCardId}`);
  const conversations = page.getByTestId('card-conversations');
  await expect(conversations).toContainText('executor');
  await conversations.locator('.session-row').filter({ hasText: 'executor' }).click();
  await expect(page).toHaveURL(`/agents/${linkedSessionId}`);

  await expect.poll(() => outboundConversationSubscribe(page, linkedSessionId)).toMatchObject({
    t: 'subscribe',
    resource: 'conversation',
    id: linkedSessionId,
  });
  const linkedSubscribe = await outboundConversationSubscribe(page, linkedSessionId) as { lease: string };
  expect(linkedSubscribe.lease).toMatch(/^[0-9a-f]{32}$/);
  const linkedConversationKey = `GET /api/agents/${encodeURIComponent(linkedSessionId)}/conversation`;
  const linkedReadsBeforeAcknowledgement = rest.counts.get(linkedConversationKey) ?? 0;
  await acknowledgeCurrentConversationLease(page, linkedSessionId, linkedSubscribe.lease);
  await expect.poll(() => rest.counts.get(linkedConversationKey) ?? 0).toBe(linkedReadsBeforeAcknowledgement + 1);
  await expect(page.getByTestId('route-agents').getByText('Synthetic agent transcript.', { exact: true })).toBeVisible();

  expect(rootRequests).toBe(1);
  expect(agentRequests).toBe(1);
  expect(analystReads).toBe(3);
  expect(rest.counts.get('GET /api/chats') ?? 0).toBe(0);
  expect(rest.unknown).toEqual([]);
});
