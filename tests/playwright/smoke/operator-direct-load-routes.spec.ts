import { expect, test, type Page } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

declare global {
  interface Window {
    promiseFailures: string[];
  }
}

const syntheticToken = 'synthetic-direct-load-token';

test('REST Analyst send, reconnect and rejected UI actions leave multi-global inventory and browser promises intact', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.promiseFailures = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.promiseFailures.push(String(event.reason));
    });
  });
  await seedTokenBeforeNavigation(page, syntheticToken);
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await page.goto('/system?section=participants');
  const inventory = page.getByRole('complementary', { name: 'Persisted agent sessions' });
  await expect(inventory).toContainText('agent:analyst:global');
  await expect(inventory).toContainText('agent:oversight:global');
  await inventory.getByRole('button', { name: /agent:oversight:global/ }).click();
  await page.evaluate(() => {
    window.__saivageWsFixture?.emit({ t: 'invalidate', resource: 'agent-membership', scope: 'global-session', session_id: 'agent:analyst:global' });
    window.__saivageWsFixture?.emit({ t: 'invalidate', resource: 'agent-membership', scope: 'global-session', session_id: 'agent:oversight:global' });
  });
  await expect.poll(() => rest.counts.get('GET /api/agents/agent%3Aanalyst%3Aglobal') ?? 0).toBeGreaterThan(0);
  await expect(inventory).toContainText('agent:analyst:global');
  await expect(inventory).toContainText('agent:oversight:global');
  await expect(inventory.getByRole('button', { name: /agent:oversight:global/ })).toHaveClass(/selected/);

  let rejectRefresh = true;
  let rejectSend = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if ((rejectRefresh && request.method() === 'GET' && path === '/api/agents') ||
        (rejectSend && request.method() === 'POST' && path === '/api/chat')) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'InternalServerError', message: 'Internal server error' }) });
    }
    return route.fallback();
  });
  await page.getByTestId('route-system').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('route-system')).toContainText('Internal server error');
  await expect(inventory).toContainText('agent:analyst:global');
  await expect(inventory).toContainText('agent:oversight:global');
  rejectRefresh = false;

  const composer = page.getByLabel('Analyst chat composer');
  await composer.fill('REST acceptance message');
  await composer.press('Enter');
  await expect.poll(() => rest.chatPosts.length).toBe(1);
  await expect(composer).toHaveValue('');
  expect(rest.chatPosts[0]!.body.content).toContain('REST acceptance message');
  const tickets = rest.counts.get('POST /api/auth/ws-ticket') ?? 0;
  const sockets = await page.evaluate(() => window.__saivageWsFixture?.sockets.length ?? 0);
  await page.evaluate(() => window.__saivageWsFixture?.closeAll());
  await expect.poll(() => rest.counts.get('POST /api/auth/ws-ticket') ?? 0).toBeGreaterThan(tickets);
  await expect.poll(() => page.evaluate(() => window.__saivageWsFixture?.sockets.length ?? 0)).toBeGreaterThan(sockets);
  await expect(page.getByTestId('strip-socket')).toHaveText(/Live|Connected/i);
  await expect.poll(() => page.evaluate(() => (window.__saivageWsFixture?.outbound ?? [])
    .map((frame) => JSON.parse(frame)).filter((frame) => frame.t === 'subscribe' && frame.resource === 'conversation' && frame.id === 'agent:analyst:global').length)).toBeGreaterThan(1);
  rejectSend = true;
  await composer.fill('Preserve rejected draft');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.chat-status-error')).toContainText('Internal server error');
  await expect(composer).toHaveValue('Preserve rejected draft');
  expect(await page.evaluate(() => (window.__saivageWsFixture?.outbound ?? []).map((frame) => JSON.parse(frame)).some((frame) => frame.type === 'message'))).toBe(false);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => window.promiseFailures)).toEqual([]);
  expect(rest.unknown).toEqual([]);
});

const smokeCardId = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const directRouteCases = [
  { path: '/', root: '[data-testid="route-cockpit"]', bodyText: /Inspecting|Synthetic dashboard smoke card/i },
  { path: '/cards', root: '[data-testid="route-cockpit"]', bodyText: /Select a card to inspect|Synthetic Project/i },
  { path: `/cards/${smokeCardId}`, root: '[data-testid="route-cockpit"]', bodyText: /Inspecting|Synthetic dashboard smoke card/i },
  { path: '/agents/agent:analyst:global', root: '[data-testid="route-cockpit"]', bodyText: /Global session|analyst/i },
  { path: '/files', root: '[data-testid="route-files"]', bodyText: /Metadata|plan\.json/i },
] as const;

const systemSectionResources = [
  'GET /api/debug/errors',
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

  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('production browser directly loads System and preserves section-owned resources', async ({ page, baseURL }) => {
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

  const beforeDefaultSystem = new Map(systemSectionResources.map((key) => [key, rest.counts.get(key) ?? 0]));
  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/system', { waitUntil: 'networkidle' })));
  await expect(page.getByTestId('route-system')).toContainText(/Runtime State|Runtime observation/i);
  await expect(page.getByTestId('debug-oversight-state')).toContainText(/Project Oversight|waiting|agent:oversight:global/i);
  await expect(page.locator('.system-sections > .system-section-button')).toHaveText([
    'State',
    'Operator observation',
    'Participants',
    'Errors',
    'Events',
    'Processes',
    'MCP',
    'Provider availability',
    'Configuration',
    'Installed workflows',
    'Actions',
    'Doctor',
  ]);
  for (const key of systemSectionResources) expect(rest.counts.get(key) ?? 0, `${key} hidden on default System`).toBe(beforeDefaultSystem.get(key));

  const selectedSystemSections = [
    { section: 'errors', label: 'Errors', resource: 'GET /api/debug/errors', bodyText: 'Synthetic provider failure redacted' },
    { section: 'participants', label: 'Participants', resource: 'GET /api/agents', bodyText: 'agent:oversight:global' },
    { section: 'mcp', label: 'MCP', resource: 'GET /api/mcp/tools', bodyText: 'filesystem' },
  ] as const;
  for (const selected of selectedSystemSections) {
    const before = new Map(systemSectionResources.map((key) => [key, rest.counts.get(key) ?? 0]));
    await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto(`/system?section=${selected.section}`, { waitUntil: 'networkidle' })));
    await expect(page.getByRole('button', { name: selected.label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('route-system')).toContainText(selected.bodyText);
    for (const key of systemSectionResources) {
      const expected = (before.get(key) ?? 0) + (key === selected.resource ? 1 : 0);
      expect(rest.counts.get(key) ?? 0, `${selected.label} section request ownership for ${key}`).toBe(expected);
    }
    if (selected.section === 'errors') {
      const errorGroup = page.locator('.error-source-group').filter({ has: page.getByRole('heading', { level: 4, name: 'planner-smoke (1)', exact: true }) });
      await expect(errorGroup).toHaveCount(1);
      const errorItem = errorGroup.locator(':scope > .error-item');
      await expect(errorItem).toHaveCount(1);
      await expect(errorItem.locator(':scope > .error-message')).toHaveText('Synthetic provider failure redacted');
      const detailCode = errorItem.locator(':scope > .code-block .code-block__code');
      await expect(detailCode).toHaveCount(1);
      const detailText = await detailCode.textContent();
      expect(detailText).not.toBeNull();
      expect(JSON.parse(detailText as string)).toEqual({ phase: 'planner-smoke', error_message: 'Synthetic provider failure redacted' });
    }
  }

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/system?section=workflows', { waitUntil: 'networkidle' })));
  await expect(page.getByTestId('debug-graphs-tab')).toContainText('Compiled Workflow Graphs');
  await expect(page.getByTestId('debug-graph-svg').locator('svg')).toHaveCount(1);
  await expect(page.getByLabel('Card type')).toHaveValue('code');
  await expect(page.getByText('status.md · work-status.v1')).toBeVisible();
  await page.getByLabel('Card type').selectOption('goal');
  await expect(page.getByTestId('debug-graph-svg').locator('title')).toHaveText('goal compiled workflow');
  await expect(page.getByText('Permitted children').locator('..')).toContainText('code');
  expect(rest.counts.get('GET /api/debug/graphs')).toBe(1);
  expect(rest.unknown).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
});
