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


test('card detail Discuss with analyst sends hidden card seed and workspace context without UI leaks', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  await page.goto('/cards/card-smoke');
  await page.evaluate((token) => window.localStorage.setItem('saivage_api_token', token), syntheticToken);
  await page.reload();

  await expect(page).toHaveURL(/\/cards\/card-smoke$/);
  await expect(page.getByText('Synthetic dashboard smoke card').first()).toBeVisible();
  await expect(page.getByText('ID: card-smoke')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Analyst chat' })).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Analyst chat composer' });
  await page.getByRole('button', { name: 'Seed analyst chat with this card' }).click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('');
  await expect(page.getByText('System context: this per-card analyst discussion')).toHaveCount(0);
  await expect(page.getByText('Tool result get_card')).toHaveCount(0);
  await expect(page.getByText(syntheticToken)).toHaveCount(0);

  const visiblePrompt = 'What should I inspect on this card?';
  await composer.fill(visiblePrompt);
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText(`Synthetic analyst response to: ${visiblePrompt}`)).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('');
  await expect(page.getByText('System context: this per-card analyst discussion')).toHaveCount(0);
  await expect(page.getByText('Tool result get_card')).toHaveCount(0);
  await expect(page.getByText(syntheticToken)).toHaveCount(0);

  expect(rest.counts.get('POST /api/chats/analyst')).toBe(1);
  expect(rest.chatPosts).toHaveLength(1);
  const post = rest.chatPosts[0];
  expect(post?.sessionId).toBe('analyst');
  expect(post?.body.workspaceContext).toEqual({ view: 'cards', entityId: 'card-smoke', refinement: null });
  expect(post?.body.content).not.toContain(syntheticToken);
  expect(post?.body.content).toContain('System context: this per-card analyst discussion was opened from the card detail view.');
  expect(post?.body.content).toContain('Card title: Synthetic dashboard smoke card');
  expect(post?.body.content).toContain('Card description: Exercise operator dashboard surfaces without provider calls.');
  expect(post?.body.content).toContain('Card status: done');
  expect(post?.body.content).toContain('Card blockers: none');
  expect(post?.body.content).toContain('Tool result get_card:');
  expect(post?.body.content).toContain('"id":"card-smoke"');
  expect(post?.body.content).toContain('"version_seq":3');
  expect(post?.body.content).toContain(`Use this seeded card context as the default subject unless the operator asks otherwise.\n\n${visiblePrompt}`);
  expect(String(post?.body.content).endsWith(visiblePrompt)).toBe(true);

  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});


test('Files view previews output files and renders preview safety states without token leaks', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  await page.goto('/files');
  await page.evaluate((token) => window.localStorage.setItem('saivage_api_token', token), syntheticToken);
  await page.reload();

  await expect(page.getByRole('region', { name: 'Metadata' })).toBeVisible();
  await expect(page.getByTestId('files-breadcrumbs').getByRole('button', { name: '.saivage' })).toBeVisible();
  await page.getByRole('button', { name: 'runtime' }).click();
  await expect(page).toHaveURL(/root=meta.*path=\.saivage\/runtime|path=\.saivage\/runtime.*root=meta/);
  await expect(page.getByTestId('files-breadcrumbs').getByRole('button', { name: 'runtime' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'events.jsonl' })).toBeVisible();

  await page.getByRole('button', { name: 'Output' }).click();
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'smoke-result.json' })).toBeVisible();

  await page.getByRole('button', { name: 'smoke-result.json' }).click();
  await expect(page.getByTestId('files-viewer')).toContainText('.saivage-work/smoke-result.json');
  await expect(page.getByText('synthetic output preview')).toBeVisible();

  await page.getByRole('button', { name: 'redacted-config.json' }).click();
  await expect(page.getByText('Sensitive values were redacted by the server.')).toBeVisible();
  await expect(page.getByText('[REDACTED]')).toBeVisible();

  await page.getByRole('button', { name: 'blocked-secret.json' }).click();
  await expect(page.getByTestId('files-viewer').locator('strong', { hasText: 'Preview blocked' })).toBeVisible();
  await expect(page.getByText('Synthetic preview blocked by content safety policy')).toBeVisible();

  await page.getByRole('button', { name: 'missing-log.txt' }).click();
  await expect(page.getByTestId('files-viewer').locator('strong', { hasText: 'File not found' })).toBeVisible();
  await expect(page.getByText('Synthetic file no longer exists')).toBeVisible();

  await page.getByRole('button', { name: 'binary.bin' }).click();
  await expect(page.getByTestId('files-viewer').locator('strong', { hasText: 'Binary preview unavailable' })).toBeVisible();
  await expect(page.getByText('Synthetic binary preview unavailable')).toBeVisible();

  await page.getByRole('button', { name: 'huge.log' }).click();
  await expect(page.getByTestId('files-viewer').locator('strong', { hasText: 'Preview too large' })).toBeVisible();
  await expect(page.getByText('Synthetic file is too large for inline preview')).toBeVisible();

  await expect(page.getByText(syntheticToken)).toHaveCount(0);
  expect(rest.counts.get('GET /api/files')).toBeGreaterThanOrEqual(3);
  expect(rest.counts.get('GET /api/files/content')).toBe(6);
  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});


test('Files view restores direct query deep links, fallback previews, root switches, and history without token leaks', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);

  await page.goto('/files?root=output&path=.saivage-work/smoke-result.json');
  await page.evaluate((token) => window.localStorage.setItem('saivage_api_token', token), syntheticToken);
  await page.reload();

  await expect(page).toHaveURL(/root=output.*path=\.saivage-work\/smoke-result\.json|path=\.saivage-work\/smoke-result\.json.*root=output/);
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'smoke-result.json' })).toBeVisible();
  await expect(page.getByTestId('files-breadcrumbs').getByRole('button', { name: '.saivage-work' })).toBeVisible();
  await expect(page.getByTestId('files-viewer')).toContainText('.saivage-work/smoke-result.json');
  await expect(page.getByText('synthetic output preview')).toBeVisible();

  await page.goto('/files?root=output&path=.saivage-work/reports');
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await expect(page.getByTestId('files-breadcrumbs').getByRole('button', { name: 'reports' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'summary.md' })).toBeVisible();
  await expect(page.getByTestId('files-viewer')).toHaveCount(0);

  await page.goto('/files?root=output&path=.saivage-work/stale/missing-log.txt');
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'smoke-result.json' })).toBeVisible();
  await expect(page.getByTestId('files-viewer').locator('strong', { hasText: 'File not found' })).toBeVisible();
  await expect(page.getByText('Synthetic file no longer exists')).toBeVisible();

  await page.getByRole('button', { name: 'Metadata' }).click();
  await expect(page).toHaveURL(/root=meta.*path=\.saivage|path=\.saivage.*root=meta/);
  await expect(page.getByRole('region', { name: 'Metadata' })).toBeVisible();
  await expect(page.getByTestId('files-viewer')).toHaveCount(0);

  await page.goto('/files?root=meta&path=.saivage/runtime');
  await expect(page.getByRole('button', { name: 'events.jsonl' })).toBeVisible();
  await page.getByRole('button', { name: 'Output' }).click();
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/root=meta.*path=\.saivage\/runtime|path=\.saivage\/runtime.*root=meta/);
  await expect(page.getByRole('region', { name: 'Metadata' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'events.jsonl' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/root=output.*path=\.saivage-work|path=\.saivage-work.*root=output/);
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();

  await expect(page.getByText(syntheticToken)).toHaveCount(0);
  expect(rest.counts.get('GET /api/files')).toBeGreaterThanOrEqual(8);
  expect(rest.counts.get('GET /api/files/content')).toBeGreaterThanOrEqual(2);
  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
