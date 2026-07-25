import { expect, test, type Page } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

const syntheticToken = 'synthetic-direct-load-token';

const directRouteCases = [
  { path: '/dashboard', root: '[data-testid="route-dashboard"]', bodyText: /Runtime Status|Restart \/ Recovery Evidence/i },
  { path: '/cards', root: '[data-testid="route-cards"]', bodyText: /Synthetic Project|Synthetic dashboard smoke card/i },
  { path: '/agents', root: '[data-testid="route-agents"]', bodyText: /agent sessions|analyst|planner/i },
  { path: '/files', root: '[data-testid="route-files"]', bodyText: /Metadata|plan\.json/i },
] as const;

const debugTabResources = [
  'GET /api/debug/errors',
  'GET /api/events',
  'GET /api/agents',
  'GET /api/mcp/tools',
] as const;

type BrowserRouterState = {
  locationPath: string;
  routePath: string | undefined;
  matchedCount: number;
};

async function routerState(page: Page): Promise<BrowserRouterState> {
  return page.evaluate(() => {
    const router = (window as Window & {
      __vueRouter?: {
        currentRoute?: {
          value?: {
            path?: string;
            matched?: unknown[];
          };
        };
      };
    }).__vueRouter;
    return {
      locationPath: window.location.pathname,
      routePath: router?.currentRoute?.value?.path,
      matchedCount: router?.currentRoute?.value?.matched?.length ?? 0,
    };
  });
}

test('production browser direct loads initialize router and render route-owned bodies', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required'); const failures=observePreviewRequestFailures(page,baseURL);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await seedTokenBeforeNavigation(page, syntheticToken);
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  for (const routeCase of directRouteCases) {
    await failures.during('full-document-navigation',()=>waitForRuntimePair(page,()=>page.goto(routeCase.path,{waitUntil:'networkidle'})));

    const routeRoot = page.locator(routeCase.root);
    await expect(routeRoot, `${routeCase.path} route root`).toHaveCount(1);
    await expect(routeRoot, `${routeCase.path} route-owned body content`).toContainText(routeCase.bodyText);

    await expect.poll(() => routerState(page), { message: `${routeCase.path} router state` }).toMatchObject({
      locationPath: routeCase.path,
      routePath: routeCase.path,
    });
    expect((await routerState(page)).matchedCount, `${routeCase.path} router matched records`).toBeGreaterThan(0);
  }

  const beforeDefaultDebug = new Map(debugTabResources.map((key) => [key, rest.counts.get(key) ?? 0]));
  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/debug', { waitUntil: 'networkidle' })));
  await expect(page.getByTestId('route-debug')).toContainText(/Runtime State|Timeline|Errors/i);
  for (const key of debugTabResources) expect(rest.counts.get(key) ?? 0, `${key} hidden on default Debug`).toBe(beforeDefaultDebug.get(key));

  const selectedDebugTabs = [
    { tab: 'errors', label: 'Errors', resource: 'GET /api/debug/errors', bodyText: 'Synthetic provider failure redacted' },
    { tab: 'timeline', label: 'Timeline', resource: 'GET /api/events', bodyText: 'runtime diagnostic' },
    { tab: 'agents', label: 'Agents', resource: 'GET /api/agents', bodyText: 'agent:analyst:global' },
    { tab: 'mcp', label: 'MCP', resource: 'GET /api/mcp/tools', bodyText: 'filesystem' },
  ] as const;
  for (const selected of selectedDebugTabs) {
    const before = new Map(debugTabResources.map((key) => [key, rest.counts.get(key) ?? 0]));
    await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto(`/debug?tab=${selected.tab}`, { waitUntil: 'networkidle' })));
    await expect(page.getByRole('button', { name: selected.label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('route-debug')).toContainText(selected.bodyText);
    for (const key of debugTabResources) {
      const expected = (before.get(key) ?? 0) + (key === selected.resource ? 1 : 0);
      expect(rest.counts.get(key) ?? 0, `${selected.label} tab request ownership for ${key}`).toBe(expected);
    }
  }

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/debug?tab=graphs', { waitUntil: 'networkidle' })));
  await expect(page.getByTestId('debug-graphs-tab')).toContainText('Compiled Workflow Graphs');
  await expect(page.getByTestId('debug-graph-svg').locator('svg')).toHaveCount(1);
  await expect(page.getByLabel('Card type')).toHaveValue('code');
  await expect(page.getByText('status.md · work-status.v1')).toBeVisible();
  await page.getByLabel('Card type').selectOption('goal');
  await expect(page.getByTestId('debug-graph-svg').locator('title')).toHaveText('goal compiled workflow');
  await expect(page.getByText('Permitted children').locator('..')).toContainText('code');
  expect(rest.counts.get('GET /api/debug/graphs')).toBe(1);
  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
