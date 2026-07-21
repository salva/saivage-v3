import { expect, test } from '@playwright/test';
import { expectedProcessList, installOperatorRestRoutes, processId, processListResponse, processOwnerId, smokeCardId } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

const syntheticToken = 'synthetic-playwright-token';

test('operator control room supports analyst chat send and migrated debug panels with synthetic fixtures', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await seedTokenBeforeNavigation(page, syntheticToken);
  await waitForRuntimePair(page, () => page.goto('/dashboard'));

  await expect(page.getByRole('region', { name: 'Analyst chat' })).toBeVisible();
  await expect(page.getByText('Synthetic agent transcript.').first()).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Analyst chat composer' });
  await composer.fill('Summarize the synthetic runtime');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Synthetic analyst response to: Summarize the synthetic runtime')).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('');
  await expect(page.getByText(syntheticToken)).toHaveCount(0);

  expect(rest.chatPosts).toHaveLength(1);
  expect(rest.chatPosts[0]?.sessionId).toBe('analyst:global');
  expect(rest.chatPosts[0]?.body).toMatchObject({
    content: 'Summarize the synthetic runtime',
    workspaceContext: { view: 'dashboard', entityId: null, refinement: null },
  });

  await page.getByText('Debug').first().click();
  await expect(page).toHaveURL(/\/debug$/);

  await page.getByRole('button', { name: 'Processes' }).click();
  expect(processListResponse).toEqual(expectedProcessList);
  const processCard = page.locator('.process-card').filter({ hasText: processId });
  await expect(processCard).toHaveCount(1); await expect(processCard.locator('.process-id')).toHaveText(processId); await expect(processCard.locator('.process-status-badge')).toHaveText('exited'); await expect(processCard).toContainText('Command:npm run synthetic-smoke'); await expect(processCard).toContainText(`Session:${processOwnerId}`); await expect(processCard).toContainText(`Owner id:${processOwnerId}`); await expect(processCard).toContainText('Owner kind:agent'); await expect(processCard).toContainText('Working directory:.'); await expect(processCard).toContainText(`Card:${smokeCardId}`); await expect(processCard).toContainText(`work:///cards/${smokeCardId}/processes/${processId}/stdout.log`); await expect(processCard).toContainText(`work:///cards/${smokeCardId}/processes/${processId}/stderr.log`);
  const endedAt = await page.evaluate((v) => new Date(v).toLocaleString([], { year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit' }), '2026-05-19T12:00:00.000Z'); await expect(processCard.locator('.pd-row').filter({hasText:'Ended:'}).locator('.pd-value')).toHaveText(endedAt);
  expect(rest.counts.get('GET /api/processes')).toBeGreaterThanOrEqual(1);

  await page.getByRole('button', { name: 'MCP' }).click();
  await expect(page.getByText('Servers:')).toBeVisible();
  await expect(page.getByText('read', { exact: true })).toBeVisible();
  await expect(page.getByText('Read a synthetic project file.')).toBeVisible();
  await expect(page.getByText('filesystem:read')).toBeVisible();
  expect(rest.counts.get('GET /api/mcp/tools')).toBeGreaterThanOrEqual(1);

  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});


test('card detail view forwards workspace context to analyst chat on send', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await seedTokenBeforeNavigation(page, syntheticToken); await waitForRuntimePair(page, () => page.goto(`/cards/${smokeCardId}`));

  await expect(page).toHaveURL(new RegExp(`/cards/${smokeCardId}$`));
  await expect(page.getByText('Synthetic dashboard smoke card').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Analyst chat' })).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Analyst chat composer' });
  const visiblePrompt = 'What should I inspect on this card?';
  await composer.fill(visiblePrompt);
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText(`Synthetic analyst response to: ${visiblePrompt}`)).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('');
  await expect(page.getByText(syntheticToken)).toHaveCount(0);

  expect(rest.chatPosts).toHaveLength(1);
  const post = rest.chatPosts[0];
  expect(post?.sessionId).toBe('analyst:global');
  expect(post?.body.workspaceContext).toEqual({ view: 'cards', entityId: smokeCardId, refinement: null });
  expect(post?.body.content).toBe(visiblePrompt);
  expect(post?.body.content).not.toContain(syntheticToken);

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
  await seedTokenBeforeNavigation(page, syntheticToken); await waitForRuntimePair(page, () => page.goto('/files'));

  await expect(page.getByRole('region', { name: 'Metadata' })).toBeVisible();
  await expect(page.getByTestId('files-breadcrumbs').getByRole('button', { name: '.saivage' })).toBeVisible();
  await page.getByRole('button', { name: 'logs' }).click(); await expect(page).toHaveURL(/root=meta.*path=\.saivage\/logs|path=\.saivage\/logs.*root=meta/); await page.getByRole('button',{name:'app.jsonl'}).click(); await expect(page.getByTestId('files-viewer')).toContainText('.saivage/logs/app.jsonl'); await expect(page.getByTestId('files-viewer')).toContainText('operator-playwright-smoke');

  await page.getByRole('button', { name: 'Output' }).click();
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'smoke-result.json' })).toBeVisible();

  await page.getByRole('button', { name: 'smoke-result.json' }).click();
  await expect(page.getByTestId('files-viewer')).toContainText('.saivage/work/smoke-result.json');
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
  expect(rest.counts.get('GET /api/files/content')).toBe(7);
  expect(rest.unknown).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});


test('Files view restores direct query deep links, fallback previews, root switches, and history without token leaks', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required');
  const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await seedTokenBeforeNavigation(page, syntheticToken);
  const navigate = <T>(action: () => Promise<T>) => failures.during(
    'full-document-navigation',
    () => waitForRuntimePair(page, action),
  );
  await navigate(() => page.goto('/files?root=output&path=.saivage/work/smoke-result.json'));

  await expect(page).toHaveURL(/root=output.*path=\.saivage\/work\/smoke-result\.json|path=\.saivage\/work\/smoke-result\.json.*root=output/);
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'smoke-result.json' })).toBeVisible();
  await expect(page.getByTestId('files-breadcrumbs').getByRole('button', { name: '.saivage/work' })).toBeVisible();
  await expect(page.getByTestId('files-viewer')).toContainText('.saivage/work/smoke-result.json');
  await expect(page.getByText('synthetic output preview')).toBeVisible();

  await navigate(() => page.goto('/files?root=output&path=.saivage/work/LICENSE'));
  await expect(page).toHaveURL(/root=output.*path=\.saivage\/work\/LICENSE|path=\.saivage\/work\/LICENSE.*root=output/);
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'LICENSE' })).toBeVisible();
  await expect(page.getByTestId('files-viewer')).toContainText('.saivage/work/LICENSE');
  await expect(page.getByText('synthetic extensionless output preview')).toBeVisible();

  await navigate(() => page.goto('/files?root=output&path=.saivage/work/reports'));
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await expect(page.getByTestId('files-breadcrumbs').getByRole('button', { name: 'reports' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'summary.md' })).toBeVisible();
  await expect(page.getByTestId('files-viewer')).toHaveCount(0);

  await navigate(() => page.goto('/files?root=output&path=.saivage/work/stale/missing-log.txt'));
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'smoke-result.json' })).toBeVisible();
  await expect(page.getByTestId('files-viewer').locator('strong', { hasText: 'File not found' })).toBeVisible();
  await expect(page.getByText('Synthetic file no longer exists')).toBeVisible();

  await page.getByRole('button', { name: 'Metadata' }).click();
  await expect(page).toHaveURL(/root=meta.*path=\.saivage|path=\.saivage.*root=meta/);
  await expect(page.getByRole('region', { name: 'Metadata' })).toBeVisible();
  await expect(page.getByTestId('files-viewer')).toHaveCount(0);

  await navigate(() => page.goto('/files?root=meta&path=.saivage/logs'));
  await expect(page.getByRole('button', { name: 'app.jsonl' })).toBeVisible();
  await page.getByRole('button', { name: 'Output' }).click();
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();
  await failures.during('full-document-navigation', () => page.goBack());
  await expect(page).toHaveURL(/root=meta.*path=\.saivage\/logs|path=\.saivage\/logs.*root=meta/);
  await expect(page.getByRole('region', { name: 'Metadata' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'app.jsonl' })).toBeVisible();
  await failures.during('full-document-navigation', () => page.goForward());
  await expect(page).toHaveURL(/root=output.*path=\.saivage\/work|path=\.saivage\/work.*root=output/);
  await expect(page.getByRole('region', { name: 'Output' })).toBeVisible();

  await expect(page.getByText(syntheticToken)).toHaveCount(0);
  expect(rest.counts.get('GET /api/files')).toBeGreaterThanOrEqual(8);
  expect(rest.counts.get('GET /api/files/content')).toBeGreaterThanOrEqual(2);
  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(pageErrors).toEqual([]);
});
