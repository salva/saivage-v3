import { expect, test } from '@playwright/test';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';

const syntheticToken = 'synthetic-playwright-token';

test('operator control room supports analyst chat send and migrated debug panels with synthetic fixtures', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  await page.goto('/dashboard');
  await page.evaluate((token) => window.localStorage.setItem('saivage_api_token', token), syntheticToken);
  await page.reload();

  await expect(page.getByRole('region', { name: 'Analyst chat' })).toBeVisible();
  await expect(page.getByText('Synthetic agent transcript.').first()).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Analyst chat composer' });
  await composer.fill('Summarize the synthetic runtime');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Synthetic analyst response to: Summarize the synthetic runtime')).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('');
  await expect(page.getByText(syntheticToken)).toHaveCount(0);

  expect(rest.counts.get('POST /api/chats/analyst')).toBe(1);
  expect(rest.chatPosts).toHaveLength(1);
  expect(rest.chatPosts[0]?.sessionId).toBe('analyst');
  expect(rest.chatPosts[0]?.body).toMatchObject({
    content: 'Summarize the synthetic runtime',
    workspaceContext: { view: 'dashboard', entityId: null, refinement: null },
  });

  await page.getByText('Debug').first().click();
  await expect(page).toHaveURL(/\/debug$/);

  await page.getByRole('button', { name: 'Processes' }).click();
  await expect(page.getByText('proc-smoke', { exact: true })).toBeVisible();
  await expect(page.getByText('npm run synthetic-smoke')).toBeVisible();
  await expect(page.getByText('Control: Ended')).toBeVisible();
  await expect(page.getByText('.saivage/tmp/processes/proc-smoke.stdout.log')).toBeVisible();
  expect(rest.counts.get('GET /api/processes')).toBeGreaterThanOrEqual(1);

  await page.getByRole('button', { name: 'MCP' }).click();
  await expect(page.getByText('Servers:')).toBeVisible();
  await expect(page.getByText('read_project_file', { exact: true })).toBeVisible();
  await expect(page.getByText('Read a synthetic project file.')).toBeVisible();
  await expect(page.getByText('filesystem:read_project_file')).toBeVisible();
  expect(rest.counts.get('GET /api/mcp/tools')).toBeGreaterThanOrEqual(1);

  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
