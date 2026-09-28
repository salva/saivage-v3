import { expect, test } from '@playwright/test';
import { installOperatorRestRoutes, smokeCardId } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

const syntheticToken = 'synthetic-playwright-token';

test('operator control room smoke walks cockpit routes with REST fixtures and WebSocket shim', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required'); const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await seedTokenBeforeNavigation(page, syntheticToken); await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/')));

  await expect(page.getByTestId('route-cockpit')).toBeVisible();
  await expect(page.getByTestId('strip-project')).toHaveText('project');
  await expect(page.locator('.analyst-pane-project-name')).toHaveText('project');
  await expect(page.getByTestId('cockpit-inspecting')).toContainText('Inspecting Synthetic dashboard smoke card');
  await expect(page.getByTestId('card-flow-title')).toHaveText('Synthetic dashboard smoke card');
  await expect(page.getByTestId('cockpit-facet-nav')).toContainText('Overview');
  await expect(page.getByText(syntheticToken)).toHaveCount(0);

  await expect.poll(async () => page.evaluate(() => window.__saivageWsFixture?.sockets.length ?? 0)).toBeGreaterThan(0);
  const socketChip = page.getByTestId('strip-socket');
  await expect(socketChip).toHaveText('Connected');
  await expect(socketChip).toHaveAttribute('title', 'WebSocket invalidations are connected; displayed runtime data still comes from REST.');

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto(`/agents/agent:planner:project`)));
  await expect(page.getByTestId('route-cockpit')).toBeVisible();
  const pagedTool=page.locator('.tool-chip').filter({hasText:'partial message slice'}); await expect(pagedTool).toContainText('1 partial message slice of 5 selected messages'); await expect(pagedTool).toContainText('12 total visible messages'); await pagedTool.getByRole('button',{name:/Expand tool read_agent_session details/}).click(); await pagedTool.getByRole('button',{name:'Show raw response'}).click(); await expect(pagedTool.getByLabel('Raw tool response')).toContainText('"total_visible_entries":12');

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/files')));
  await expect(page.getByText('plan.json')).toBeVisible();
  await page.getByText('plan.json').click();
  await expect(page.getByText('operator-playwright-smoke')).toBeVisible();

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/system?section=errors')));
  await expect(page.getByTestId('route-system')).toContainText('Synthetic provider failure redacted');

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/route-that-does-not-exist')));
  await expect(page.getByRole('heading', { name: /404 — Not found/i })).toBeVisible();
  await expect(page.getByText('/route-that-does-not-exist')).toBeVisible();

  expect(rest.unknown).toEqual([]);
  expect(pageErrors).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
});
