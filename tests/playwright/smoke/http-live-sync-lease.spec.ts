import { networkInterfaces } from 'node:os';
import { expect, test, type Route } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const token = 'synthetic-http-live-sync-token';
const sessionId = 'agent:planner:project';
const port = Number(process.env.SAIVAGE_PLAYWRIGHT_WEB_PORT ?? 4177);
const progressCardA = 'card-a';
const progressCardB = 'card-b';
const progressSessionA = `agent:executor:${progressCardA}`;
const progressSessionB = `agent:executor:${progressCardB}`;
const fixtureNow = '2026-09-09T12:00:00.000Z';

function nonInternalIpv4Address(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  throw new Error('HTTP live-sync browser prerequisite failed: no non-internal IPv4 interface is available to local Chromium');
}

test('conversation leases work on a real non-loopback plain-HTTP origin', async ({ page }) => {
  const address = nonInternalIpv4Address();
  const origin = `http://${address}:${port}`;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript((value) => window.localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page, { autoAcknowledge: false });
  const rest = await installOperatorRestRoutes(page);

  await page.goto(`${origin}/agents/${encodeURIComponent(sessionId)}`);
  expect(new URL(page.url()).hostname).toBe(address);
  expect(await page.evaluate(() => ({
    secure: window.isSecureContext,
    randomUUID: typeof globalThis.crypto.randomUUID,
    getRandomValues: typeof globalThis.crypto.getRandomValues,
  }))).toEqual({ secure: false, randomUUID: 'undefined', getRandomValues: 'function' });

  const socketChip = page.locator('.workspace-header .ws-connected');
  await expect(socketChip).toHaveText('Live');
  await expect(socketChip).toHaveAttribute('title', 'WebSocket invalidations are connected; displayed runtime data still comes from REST.');
  await expect.poll(() => page.evaluate((id) => {
    const frames = (window.__saivageWsFixture?.outbound ?? []).map((frame) => JSON.parse(frame) as Record<string, unknown>);
    return frames.find((frame) => frame.t === 'subscribe' && frame.resource === 'conversation' && frame.id === id) ?? null;
  }, sessionId)).toMatchObject({ t: 'subscribe', resource: 'conversation', id: sessionId });

  const subscribe = await page.evaluate((id) => {
    const frames = (window.__saivageWsFixture?.outbound ?? []).map((frame) => JSON.parse(frame) as Record<string, unknown>);
    return frames.find((frame) => frame.t === 'subscribe' && frame.resource === 'conversation' && frame.id === id)!;
  }, sessionId) as { lease: string };
  expect(subscribe.lease).toMatch(/^[0-9a-f]{32}$/);

  const conversationKey = `GET /api/agents/${encodeURIComponent(sessionId)}/conversation`;
  const readsBeforeAcknowledgement = rest.counts.get(conversationKey) ?? 0;
  await page.evaluate(({ id, lease }) => window.__saivageWsFixture?.emit({
    t: 'subscribed',
    resource: 'conversation',
    id,
    lease,
  }), { id: sessionId, lease: subscribe.lease });
  await expect.poll(() => rest.counts.get(conversationKey) ?? 0).toBe(readsBeforeAcknowledgement + 1);
  const retained = page.getByTestId('retained-instruction-context');
  await expect(retained).toContainText('Retained instruction context');
  await expect(retained).toContainText('Preserve this exact operator constraint.');
  await expect(retained).toContainText('key: smoke.constraint');

  await page.evaluate(() => {
    window.history.pushState({}, '', '/agents');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(`${origin}/agents`);
  await expect.poll(() => page.evaluate(({ id, lease }) => {
    const frames = (window.__saivageWsFixture?.outbound ?? []).map((frame) => JSON.parse(frame) as Record<string, unknown>);
    return frames.some((frame) => frame.t === 'unsubscribe' && frame.resource === 'conversation' && frame.id === id && frame.lease === lease);
  }, { id: sessionId, lease: subscribe.lease })).toBe(true);

  expect(rest.unknown).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('mixed held Agents scopes clear selected compaction through a trailing authoritative baseline', async ({ page }) => {
  const address = nonInternalIpv4Address();
  const origin = `http://${address}:${port}`;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript((value) => window.localStorage.setItem('saivage_api_token', value), token);
  await installOperatorWebSocketShim(page, { autoAcknowledge: false });
  const rest = await installOperatorRestRoutes(page);

  const compacting = {
    strategy: 'preventive',
    started_at: fixtureNow,
    folds_done: 2,
    fold_in_flight: true,
  };
  const sessionA = {
    id: progressSessionA,
    agent_name: 'executor',
    session_scope: 'card',
    card_id: progressCardA,
    started_at: fixtureNow,
    status: 'active',
    activity: 'busy',
    compaction: compacting as typeof compacting | null,
  };
  const sessionB = {
    ...sessionA,
    id: progressSessionB,
    card_id: progressCardB,
    compaction: null,
  };
  const observed = {
    inventory: 0,
    inventoryCompleted: 0,
    cardB: 0,
    detailA: 0,
    detailACompleted: 0,
    detailB: 0,
  };
  let releaseCardB!: () => void;
  const cardBGate = new Promise<void>((resolve) => { releaseCardB = resolve; });
  let authoritativeCompaction: typeof compacting | null = compacting;
  const fulfill = (route: Route, payload: unknown) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.fallback();
    if (pathname === '/api/agents') {
      observed.inventory += 1;
      await fulfill(route, { sessions: [{ ...sessionA, compaction: authoritativeCompaction }, sessionB] });
      observed.inventoryCompleted += 1;
      return;
    }
    if (pathname === `/api/cards/${progressCardB}/agent-sessions`) {
      observed.cardB += 1;
      await cardBGate;
      return fulfill(route, { card_id: progressCardB, sessions: [sessionB] });
    }
    if (pathname === `/api/agents/${encodeURIComponent(progressSessionA)}`) {
      observed.detailA += 1;
      await fulfill(route, { session: { ...sessionA, compaction: authoritativeCompaction } });
      observed.detailACompleted += 1;
      return;
    }
    if (pathname === `/api/agents/${encodeURIComponent(progressSessionB)}`) {
      observed.detailB += 1;
      return fulfill(route, { session: sessionB });
    }
    return route.fallback();
  });

  await page.goto(`${origin}/agents/${encodeURIComponent(progressSessionA)}`);
  await expect.poll(() => page.evaluate((id) => {
    const frames = (window.__saivageWsFixture?.outbound ?? []).map((frame) => JSON.parse(frame) as Record<string, unknown>);
    return {
      agents: frames.some((frame) => frame.t === 'subscribe' && frame.resource === 'agents'),
      selectedConversation: frames.some((frame) => frame.t === 'subscribe' && frame.resource === 'conversation' && frame.id === id),
    };
  }, progressSessionA)).toEqual({ agents: true, selectedConversation: true });
  const leases = await page.evaluate((id) => {
    const frames = (window.__saivageWsFixture?.outbound ?? []).map((frame) => JSON.parse(frame) as Record<string, unknown>);
    return {
      agents: frames.find((frame) => frame.t === 'subscribe' && frame.resource === 'agents') as { lease: string },
      conversation: frames.find((frame) => frame.t === 'subscribe' && frame.resource === 'conversation' && frame.id === id) as { lease: string },
    };
  }, progressSessionA);
  expect(observed).toEqual({
    inventory: 0,
    inventoryCompleted: 0,
    cardB: 0,
    detailA: 0,
    detailACompleted: 0,
    detailB: 0,
  });
  await page.evaluate(({ agentsLease }) => {
    window.__saivageWsFixture?.emit({ t: 'subscribed', resource: 'agents', lease: agentsLease });
  }, { agentsLease: leases.agents.lease });
  await expect.poll(() => ({
    inventory: observed.inventory,
    inventoryCompleted: observed.inventoryCompleted,
    detailA: observed.detailA,
    detailACompleted: observed.detailACompleted,
  })).toEqual({ inventory: 1, inventoryCompleted: 1, detailA: 1, detailACompleted: 1 });

  await page.evaluate(({ id, conversationLease }) => {
    window.__saivageWsFixture?.emit({ t: 'subscribed', resource: 'conversation', id, lease: conversationLease });
  }, { id: progressSessionA, conversationLease: leases.conversation.lease });

  const banner = page.getByTestId('compaction-progress');
  await expect(banner).toContainText('Compacting history — 2 summary calls completed');
  await expect(banner).toContainText('Elapsed');
  const conversationKey = `GET /api/agents/${encodeURIComponent(progressSessionA)}/conversation`;
  await expect.poll(() => ({
    detailA: observed.detailA,
    detailACompleted: observed.detailACompleted,
    transcript: rest.counts.get(conversationKey) ?? 0,
  })).toEqual({ detailA: 2, detailACompleted: 2, transcript: 1 });
  const inventoryAfterAcknowledgement = observed.inventory;
  const detailAfterAcknowledgement = observed.detailA;
  const transcriptAfterAcknowledgement = rest.counts.get(conversationKey) ?? 0;
  expect(inventoryAfterAcknowledgement).toBe(1);
  expect(detailAfterAcknowledgement).toBe(2);
  expect(transcriptAfterAcknowledgement).toBe(1);

  await page.evaluate((cardId) => window.__saivageWsFixture?.emit({
    t: 'invalidate',
    resource: 'agent-membership',
    scope: 'card',
    card_id: cardId,
  }), progressCardB);
  await expect.poll(() => observed.cardB).toBe(1);

  authoritativeCompaction = null;
  await page.evaluate(({ cardA, cardB }) => {
    window.__saivageWsFixture?.emit({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: cardA });
    window.__saivageWsFixture?.emit({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: cardB });
  }, { cardA: progressCardA, cardB: progressCardB });
  expect(observed.inventory).toBe(inventoryAfterAcknowledgement);
  expect(observed.detailA).toBe(detailAfterAcknowledgement);

  releaseCardB();
  await expect.poll(() => ({ started: observed.inventory, completed: observed.inventoryCompleted })).toEqual({
    started: inventoryAfterAcknowledgement + 1,
    completed: inventoryAfterAcknowledgement + 1,
  });
  await expect.poll(() => ({ started: observed.detailA, completed: observed.detailACompleted })).toEqual({
    started: detailAfterAcknowledgement + 1,
    completed: detailAfterAcknowledgement + 1,
  });
  await expect(banner).toHaveCount(0);

  expect(observed.inventory).toBe(inventoryAfterAcknowledgement + 1);
  expect(observed.detailA).toBe(detailAfterAcknowledgement + 1);
  expect(observed.cardB).toBe(1);
  expect(observed.detailB).toBe(0);
  expect(rest.counts.get(conversationKey) ?? 0).toBe(transcriptAfterAcknowledgement);
  expect(rest.unknown).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
