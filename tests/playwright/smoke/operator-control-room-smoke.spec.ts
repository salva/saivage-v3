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
  await seedTokenBeforeNavigation(page, syntheticToken); await waitForRuntimePair(page, () => page.goto('/'));

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

  await waitForRuntimePair(page, () => page.goto(`/agents/agent:planner:project`));
  await expect(page.getByTestId('route-cockpit')).toBeVisible();
  const reader = page.getByRole('region', { name: 'Focused conversation reader', exact: true });
  const pagedTool = reader.getByRole('group', { name: 'tool read_agent_session', exact: true });
  await expect(pagedTool).toHaveCount(1);
  await expect(pagedTool).toBeVisible();
  const expandTool = pagedTool.getByRole('button', { name: 'Expand tool read_agent_session details', exact: true });
  await expect(expandTool).toHaveAttribute('aria-expanded', 'false');
  await expect(expandTool).toContainText('Read selected session');
  await expect(expandTool.getByText('agent:planner:project', { exact: true })).toBeVisible();
  for (const qualifier of ['Observation recorded', 'Partial coverage', 'Partial JSON items', '1 of 5 selected messages']) {
    await expect(expandTool.getByText(qualifier)).toBeVisible();
  }

  await expandTool.click();
  await expect(pagedTool.getByRole('button', { name: 'Collapse tool read_agent_session details', exact: true })).toHaveAttribute('aria-expanded', 'true');
  const result = pagedTool.getByRole('heading', { name: 'Result', exact: true }).locator('..');
  const observation = result.getByRole('heading', { name: 'Recorded observation (not a live monitor)', exact: true }).locator('..');
  await expect(observation.locator('dl > div').filter({ has: page.getByText('Full visible message count', { exact: true }) }).locator('dd')).toHaveText('12');
  const selectedCoverage = result.getByRole('heading', { name: 'Selected messages — recorded coverage', exact: true }).locator('..');
  for (const [label, value] of [['total', '5'], ['returned', '1']]) {
    await expect(selectedCoverage.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText(value);
  }
  const partialItem = result.getByRole('heading', { name: 'Partial JSON item 1 (not a complete observation)', exact: true }).locator('..');
  await expect(partialItem).toBeVisible();
  await expect(partialItem.getByText('7b22', { exact: true })).toBeVisible();
  for (const [label, value] of [['utf8 bytes', '2'], ['offset bytes', '0'], ['next offset bytes', '2'], ['total bytes', '40']]) {
    await expect(partialItem.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText(value);
  }

  await result.locator('summary').filter({ hasText: /^Safe original result$/ }).click();
  const safeOriginal = result.getByLabel('Safe original tool result', { exact: true });
  await expect(safeOriginal).toBeVisible();
  await expect(safeOriginal).toContainText('"total_visible_entries":12');

  await waitForRuntimePair(page, () => page.goto('/files'));
  await expect(page.getByText('plan.json')).toBeVisible();
  await page.getByText('plan.json').click();
  await expect(page.getByText('operator-playwright-smoke')).toBeVisible();

  await waitForRuntimePair(page, () => page.goto('/system?section=errors'));
  await expect(page.getByTestId('route-system')).toContainText('Synthetic provider failure redacted');

  await waitForRuntimePair(page, () => page.goto('/route-that-does-not-exist'));
  await expect(page.getByRole('heading', { name: /404 — Not found/i })).toBeVisible();
  await expect(page.getByText('/route-that-does-not-exist')).toBeVisible();

  expect(rest.unknown).toEqual([]);
  expect(pageErrors).toEqual([]);
  assertPreviewRequestFailures(failures);
});
