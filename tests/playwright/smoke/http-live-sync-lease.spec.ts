import { networkInterfaces } from 'node:os';
import { expect, test } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const token = 'synthetic-http-live-sync-token';
const sessionId = 'agent:planner:project';
const port = Number(process.env.SAIVAGE_PLAYWRIGHT_WEB_PORT ?? 4177);

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
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  await page.goto(`${origin}/agents/${encodeURIComponent(sessionId)}`);
  expect(new URL(page.url()).hostname).toBe(address);
  expect(await page.evaluate(() => ({
    secure: window.isSecureContext,
    randomUUID: typeof globalThis.crypto.randomUUID,
    getRandomValues: typeof globalThis.crypto.getRandomValues,
  }))).toEqual({ secure: false, randomUUID: 'undefined', getRandomValues: 'function' });

  await expect(page.getByText(/Live updates connected/i).first()).toBeVisible();
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
