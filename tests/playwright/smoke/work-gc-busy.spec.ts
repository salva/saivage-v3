import { expect, test } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { WORK_GC_BUSY_ERROR } from '../../../src/contracts/work-gc.js';
import { installOperatorRestRoutes, smokeCardId, smokeServerAvailability } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

// Presentation-only route fixture: real hold ownership/deletion is covered by server E2E.
// Runtime/MCP lifecycle controls are intentionally absent from the current UI.
// Light/dark are browser preferences, not a claim that the fixed UI palette has two themes.
for (const colorScheme of ['light', 'dark'] as const) {
  test(`GC busy preserves Analyst error and read-only views (${colorScheme} preference)`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await seedTokenBeforeNavigation(page, 'synthetic-gc-token');
    await installOperatorWebSocketShim(page);
    const rest = await installOperatorRestRoutes(page);
    let stopped = false;
    const mutations: string[] = [];
    const now = '2026-05-19T12:00:00.000Z';
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const busyOperations = {
        '/api/runtime/resume': 'runtime.resume',
        '/api/chat': 'chats.send',
        '/api/mcp/servers/filesystem/restart': 'mcp.restart',
      } as const;
      if (method === 'POST' && path in busyOperations) {
        mutations.push(path);
        const operation = busyOperations[path as keyof typeof busyOperations];
        return route.fulfill({ status: 409, json: parseOperatorResponse(operation, 409, WORK_GC_BUSY_ERROR) });
      }
      if (method === 'POST' && path === '/api/runtime/stop-project') {
        mutations.push(path);
        stopped = true;
        return route.fulfill({ json: parseOperatorResponse('stop_project', 200, { status: 'stopped', contained: true }) });
      }
      if (method === 'GET' && path === '/api/state') {
        return route.fulfill({ json: parseOperatorResponse('runtime.getState', 200, {
          projectId: 'project', serverAvailability: smokeServerAvailability,
          runtime: stopped ? null : { status: 'paused', project_id: 'project', pid: 4242, started_at: now, current_card_id: smokeCardId, updated_at: now },
        }) });
      }
      if (method === 'GET' && path === '/api/runtime/status') {
        return route.fulfill({ json: parseOperatorResponse('runtime.status', 200, {
          runtime: stopped ? 'stopped' : 'paused', currentCardId: stopped ? null : smokeCardId, started_at: now, pid: 4242,
          actorRuntime: { pauseMode: stopped ? 'running' : 'paused', cards: [] },
          oversight: { agent_name: 'oversight', session_id: 'agent:oversight:global', enabled: true, eligible: false, eligibility_reason: stopped ? 'stopped' : 'paused', state: 'unavailable', next_nominal_due: null, last_attempt: null, last_successful_at: null, service_epoch: now },
          restart_server_available: false, serverAvailability: smokeServerAvailability,
        }) });
      }
      return route.fallback();
    });

    await waitForRuntimePair(page, () => page.goto(`/cards/${smokeCardId}`));
    await expect(page.getByTestId('strip-lifecycle')).toContainText(/paused/i);
    const composer = page.getByLabel('Analyst chat composer');
    await composer.fill('Inspect this synthetic GC hold');
    await composer.press('Enter');
    await expect(page.getByRole('region', { name: 'Analyst chat', exact: true }).getByRole('alert')).toHaveText(WORK_GC_BUSY_ERROR.message);
    await expect(page.getByRole('region', { name: 'Analyst chat', exact: true }).getByRole('alert')).toBeVisible();
    await expect(composer).toHaveValue('Inspect this synthetic GC hold');
    await expect(composer).toBeEnabled();
    await page.getByRole('button', { name: 'Dismiss Failed to send Analyst message', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Analyst chat', exact: true }).getByRole('alert')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`analyst-busy-${colorScheme}.png`), fullPage: true });

    // These are explicit browser API observations, NOT nonexistent UI button tests.
    for (const path of ['/api/runtime/resume', '/api/mcp/servers/filesystem/restart']) {
      const response = await page.evaluate(async path => {
        const result = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer synthetic-gc-token' } });
        return { status: result.status, body: await result.json() };
      }, path);
      expect(response).toEqual({ status: 409, body: WORK_GC_BUSY_ERROR });
    }
    await waitForRuntimePair(page, () => page.goto('/files'));
    await expect(page.getByTestId('strip-lifecycle')).toContainText(/paused/i);
    await page.getByText('plan.json', { exact: true }).click();
    await expect(page.getByText('operator-playwright-smoke')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`files-held-${colorScheme}.png`), fullPage: true });

    await waitForRuntimePair(page, () => page.goto('/system?section=mcp'));
    await expect(page.getByText('filesystem', { exact: true })).toBeVisible();
    await expect(page.getByText('No failure reported', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`mcp-read-only-${colorScheme}.png`), fullPage: true });

    await waitForRuntimePair(page, () => page.goto('/system?section=doctor'));
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(page.getByText('Cards loaded successfully.', { exact: true })).toBeVisible();
    await expect(page.getByText('All checks passed (1 checks)', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`doctor-held-${colorScheme}.png`), fullPage: true });

    await waitForRuntimePair(page, () => page.goto('/system?section=operator'));
    await expect(page.getByText('Runtime Diagnostics', { exact: true })).toBeVisible();
    await expect(page.getByTestId('strip-rest')).toHaveText('REST Observed');
    await expect(page.getByText('System is diagnostic-only.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Resume|Stop project|Restart MCP)$/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`diagnostics-held-${colorScheme}.png`), fullPage: true });
    const stop = await page.evaluate(async () => {
      const result = await fetch('/api/runtime/stop-project', { method: 'POST', headers: { Authorization: 'Bearer synthetic-gc-token' } });
      return { status: result.status, body: await result.json() };
    });
    expect(stop).toEqual({ status: 200, body: { status: 'stopped', contained: true } });
    await waitForRuntimePair(page, () => page.reload());
    await expect(page.getByTestId('strip-lifecycle')).toContainText(/stopped/i);
    await page.screenshot({ path: testInfo.outputPath(`stop-observed-${colorScheme}.png`), fullPage: true });
    expect(mutations).toEqual(['/api/chat', '/api/runtime/resume', '/api/mcp/servers/filesystem/restart', '/api/runtime/stop-project']);
    expect(rest.unknown).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(colorScheme === 'dark');
  });
}
