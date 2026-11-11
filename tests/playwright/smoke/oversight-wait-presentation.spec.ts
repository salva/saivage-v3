import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { parseOperatorResponse, type OperatorApiSuccess } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeServerAvailability } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`Oversight is a sampled wait, not a wall deadline (${viewport.width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(new Date('2026-05-19T13:51:00Z'));
    await page.addInitScript(() => localStorage.setItem('saivage_api_token', 'synthetic-oversight-token'));
    await installOperatorWebSocketShim(page);
    await installOperatorRestRoutes(page);
    let oversight: OperatorApiSuccess<'runtime.status'>['oversight'] = {
      agent_name: 'oversight', session_id: 'agent:oversight:global', enabled: true,
      eligible: true, eligibility_reason: null, state: 'waiting', remaining_wait_ms: 541_000.5,
      last_attempt: { outcome: 'succeeded', settled_at: '2026-05-18T21:00:00.000Z' },
      last_successful_at: '2026-05-18T21:00:00.000Z', service_epoch: '2026-05-18T20:00:00.000Z',
    };
    let fail = false;
    await page.route('**/api/runtime/status', async (route) => {
      if (fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'InternalServerError', message: 'Internal server error' }) });
      const body = parseOperatorResponse('runtime.status', 200, {
        runtime: 'running', currentCardId: null, started_at: oversight.service_epoch, pid: 4242,
        actorRuntime: { pauseMode: 'running', cards: [] }, oversight,
        restart_server_available: false, serverAvailability: smokeServerAvailability,
      });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/system');
    const panel = page.getByTestId('debug-oversight-state');
    const chip = page.getByTestId('strip-oversight');
    await expect(chip).toHaveText('Oversight waiting');
    await expect(panel).toContainText('Remaining timer wait at last observation:About 9m 2s');
    await expect(chip).toHaveAttribute('title', /last observation: About 9m 2s/);
    await expect(chip).toHaveAttribute('title', /No wall-clock check deadline/);
    await page.clock.setFixedTime(new Date('2026-05-19T17:00:00Z'));
    await expect(panel).toContainText('About 9m 2s');
    await expect(panel).not.toContainText(/Next due|overdue/i);
    const explanation = page.getByTestId('oversight-wait-explanation');
    await expect(explanation).toHaveText('Sampled server monotonic time, not a live countdown. Host sleep can pause this wait; no wall-clock check deadline or catch-up is promised.');
    await explanation.scrollIntoViewIfNeeded();
    await expect(explanation).toBeInViewport();
    const readable = await explanation.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: window.innerWidth, clipped: element.scrollWidth > element.clientWidth };
    });
    expect(readable.left).toBeGreaterThanOrEqual(0);
    expect(readable.right).toBeLessThanOrEqual(readable.width);
    expect(readable.clipped).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`oversight-wait-${viewport.width}.png`), fullPage: true });
    const domPath = testInfo.outputPath(`oversight-wait-${viewport.width}.html`);
    await writeFile(domPath, await panel.evaluate((element) => element.outerHTML));
    await testInfo.attach('sampled-wait-dom', { path: domPath, contentType: 'text/html' });

    // Use the ordinary runtime invalidation refresh, never a new polling path.
    async function refresh() { await page.evaluate(() => window.__saivageWsFixture!.emitRuntimeUpdate()); }
    fail = true; await refresh();
    await expect(page.getByTestId('strip-rest')).toHaveText('REST Refresh failed');
    await expect(panel).toContainText('About 9m 2s');
    fail = false; oversight = { ...oversight, remaining_wait_ms: 60_001 }; await refresh();
    await expect(panel).toContainText('About 1m 1s');
    oversight = { ...oversight, remaining_wait_ms: 0 }; await refresh();
    await expect(panel).toContainText('Timer wait elapsed; check not yet observed');
    await expect(chip).toHaveText('Oversight waiting');
    for (const state of ['checking', 'unavailable'] as const) {
      oversight = { ...oversight, state, eligible: false, eligibility_reason: state === 'checking' ? 'check_in_flight' : 'application_closing', remaining_wait_ms: null };
      await refresh();
      await expect(chip).toHaveText(`Oversight ${state}`);
      await expect(panel).toContainText('No armed wait');
      await expect(chip).toHaveAttribute('title', /No armed wait/);
      await expect(panel).toContainText('Last success:');
    }
  });
}
