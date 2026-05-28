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
