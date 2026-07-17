import { expect, test, type Page } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const syntheticToken = 'synthetic-direct-load-token';

const directRouteCases = [
  { path: '/dashboard', root: '[data-testid="route-dashboard"]', bodyText: /Runtime Status|Restart \/ Recovery Evidence/i },
  { path: '/cards', root: '[data-testid="route-cards"]', bodyText: /Synthetic Project|Synthetic dashboard smoke card/i },
  { path: '/agents', root: '[data-testid="route-agents"]', bodyText: /agent sessions|analyst|planner/i },
  { path: '/files', root: '[data-testid="route-files"]', bodyText: /Metadata|plan\.json/i },
  { path: '/debug', root: '[data-testid="route-debug"]', bodyText: /Runtime State|Timeline|Errors/i },
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

test('production browser direct loads initialize router and render route-owned bodies', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? '';
    if (errorText !== 'net::ERR_ABORTED') failedRequests.push(`${request.method()} ${request.url()} ${errorText}`);
  });

  await page.addInitScript((token) => window.localStorage.setItem('saivage_api_token', token), syntheticToken);
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  for (const routeCase of directRouteCases) {
    await page.goto(routeCase.path, { waitUntil: 'networkidle' });

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
  expect(failedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
