import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { parseOperatorResponse, type OperatorApiSuccess } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeServerAvailability } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`cooperative pause guidance is observational and accessible (${viewport.width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem('saivage_api_token', 'synthetic-pause-token'));
    await installOperatorWebSocketShim(page);
    await installOperatorRestRoutes(page);
    let lifecycle: OperatorApiSuccess<'runtime.status'>['runtime'] = 'running';
    let fail = false;
    const runtimePosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/(runtime|project)(\/|$)/.test(new URL(request.url()).pathname)) {
        runtimePosts.push(request.url());
      }
    });
    await page.route('**/api/runtime/status', async (route) => {
      if (fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'InternalServerError', message: 'Internal server error' }) });
      const body = parseOperatorResponse('runtime.status', 200, {
        runtime: lifecycle, currentCardId: null, started_at: '2026-05-19T12:00:00.000Z', pid: 4242,
        actorRuntime: { pauseMode: lifecycle === 'paused' ? 'paused' : 'running', cards: [] },
        oversight: {
          agent_name: 'oversight', session_id: 'agent:oversight:global', enabled: false,
          eligible: false, eligibility_reason: 'disabled', state: 'unavailable', remaining_wait_ms: null,
          last_attempt: null, last_successful_at: null, service_epoch: '2026-05-19T12:00:00.000Z',
        },
        restart_server_available: false, serverAvailability: smokeServerAvailability,
      });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    // The ordinary state fixture stays running throughout: only accepted status
    // owns the lifecycle chip/help, never a fallback between independent samples.
    await page.goto('/system');
    const strip = page.getByTestId('global-strip');
    const guidance = page.getByTestId('strip-runtime-guidance');
    const summary = guidance.locator('summary');
    const body = guidance.locator('.strip-guidance-body');
    const chip = page.getByTestId('strip-lifecycle');
    await expect(chip).toHaveText('Running');
    await expect(body).not.toBeVisible();
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(body).toBeVisible();
    await expect(summary).toHaveAttribute('aria-describedby', 'strip-lifecycle');
    await expect(body).toContainText('wait for observed Paused');
    await expect(body).toContainText('no new Start is needed');

    async function receipt(state: string, label = state.toLowerCase()) {
      await expect(body).toBeVisible();
      await expect(body).toContainText(`Last observed lifecycle: ${state}.`);
      await expect(body).toContainText('Operations recheck current state and their own permissions; other holds may still refuse them.');
      await expect(chip).toHaveAttribute('aria-description', new RegExp(`Last observed lifecycle: ${state}`));
      await expect(strip.getByRole('alert')).toHaveCount(0);
      await expect(strip.getByRole('button', { name: /Start|Stop|Pause|Resume|Restart/i })).toHaveCount(0);
      await expect(body).not.toContainText(/countdown|waiting for tool|remaining time|deadlock/i);
      const geometry = await body.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, viewport: window.innerWidth, clipped: element.scrollWidth > element.clientWidth };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.clipped).toBe(false);
      await strip.screenshot({ path: testInfo.outputPath(`${label}-${viewport.width}.png`) });
      const domPath = testInfo.outputPath(`${label}-${viewport.width}.html`);
      await writeFile(domPath, await strip.evaluate((element) => element.outerHTML));
      await testInfo.attach(`${label}-dom`, { path: domPath, contentType: 'text/html' });
      const geometryPath = testInfo.outputPath(`${label}-${viewport.width}-geometry.json`);
      await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
    }
    async function refresh() { await page.evaluate(() => window.__saivageWsFixture!.emitRuntimeUpdate()); }
    await receipt('Running');
    lifecycle = 'pausing'; await refresh();
    await expect(chip).toHaveText('Pausing');
    await expect(body).toContainText('no time bound');
    await expect(body).toContainText('Already-admitted provider attempts/retries, tools and processes may continue');
    await expect(body).toContainText('not a way to skip Pausing');
    await receipt('Pausing');
    lifecycle = 'paused'; await refresh();
    await expect(chip).toHaveText('Paused');
    await expect(body).toContainText('Resume to continue the same Run, not a new Run/Start');
    await expect(body).toContainText('subject to current per-operation admission');
    await expect(body).toContainText('does not mean all processes or global work have stopped');
    await receipt('Paused');
    // Space also operates the native disclosure, without a custom keyboard path.
    await summary.focus(); await page.keyboard.press('Space');
    await expect(body).not.toBeVisible();
    await page.keyboard.press('Space'); await expect(body).toBeVisible();
    fail = true; await refresh();
    await expect(page.getByTestId('strip-rest')).toHaveText('REST Refresh failed');
    await expect(page.getByTestId('strip-rest')).toHaveAttribute('title', /Last successful observation is retained; the latest refresh failed:/);
    await expect(chip).toHaveText('Paused');
    await receipt('Paused', 'failed-refresh');
    expect(runtimePosts).toEqual([]);
    await writeFile(testInfo.outputPath(`runtime-posts-${viewport.width}.json`), JSON.stringify({ runtimePosts }, null, 2));
  });
}
