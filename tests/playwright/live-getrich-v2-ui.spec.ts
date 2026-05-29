import { expect, test } from '@playwright/test';

/**
 * Live UI interactions against http://10.0.3.170:8080. Exercises the
 * Vue shell beyond the basic nav sweep. Read-only on the runtime.
 */

test.describe('saivage-v3 live deployment — UI interaction coverage', () => {
  test('Cards view renders the tree and clicking a node opens the detail panel', async ({ page }) => {
    await page.goto('/cards');
    const firstNode = page.locator('.tree-node').first();
    await expect(firstNode).toBeVisible({ timeout: 10_000 });
    await firstNode.click();
    await expect(page).toHaveURL(/\/cards\/[^/]+/);
    await expect(page.getByRole('button', { name: /Back to Cards/i })).toBeVisible();
  });

  test('Files view renders the canonical panel with at least one entry', async ({ page }) => {
    await page.goto('/files');
    await expect(page.locator('[data-testid="files-canonical-panel"]')).toBeVisible({ timeout: 10_000 });
    const list = page.locator('[data-testid="files-list"]');
    await expect(list).toBeVisible();
    const entries = list.locator('.file-entry');
    expect(await entries.count()).toBeGreaterThan(0);
  });

  test('Debug view renders the tab strip without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/debug');
    await expect(page.locator('.debug-tabs')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.debug-tab-button').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Analyst chat composer is visible on the dashboard and the Send button toggles with input', async ({ page }) => {
    await page.goto('/dashboard');
    const composer = page.getByRole('textbox', { name: /Analyst chat composer/i });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    const send = page.getByRole('button', { name: /^Send$/i });
    await expect(send).toBeDisabled();
    await composer.fill('hello');
    await expect(send).toBeEnabled();
    await composer.fill('');
    await expect(send).toBeDisabled();
  });

  test('Card detail view shows the history panel section for the project card', async ({ page }) => {
    await page.goto('/cards/project');
    await expect(page.locator('[data-testid="card-detail-highlight"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /Card history/i })).toBeVisible();
  });

  test('Debug view exposes operator, errors, timeline, mcp, processes, and supervision tabs', async ({ page }) => {
    await page.goto('/debug');
    await expect(page.locator('.debug-tabs')).toBeVisible({ timeout: 10_000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    for (const tab of ['Operator', 'Errors', 'Timeline', 'MCP', 'Processes', 'Supervision']) {
      const btn = page.locator('.debug-tab-button', { hasText: new RegExp(`^${tab}`, 'i') }).first();
      await btn.click();
      await expect(page.locator('.debug-tab-content')).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test('Navigating directly to /agents/analyst surfaces the session id', async ({ page }) => {
    await page.goto('/agents/analyst');
    await expect(page.getByText('analyst').first()).toBeVisible({ timeout: 10_000 });
  });
});
