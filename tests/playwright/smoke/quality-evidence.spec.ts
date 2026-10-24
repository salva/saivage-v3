import { test, expect } from '@playwright/test';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { postStartProject, waitFor } from '../../helpers/production-composition-e2e.js';
import { loadPackagedExecutionFixture } from './fixtures/packaged-execution-fixture.js';

test.describe.configure({ timeout: 120000, retries: 0 });
for (const nativeCase of ['clean', 'defect', 'config-error', 'timeout'] as const) {
  test(`actual typed quality ${nativeCase}: accepted report, history, execution and work navigation`, async ({ page }, testInfo) => {
    if (!process.env.SAIVAGE_QUALITY_NATIVE_ROOT || process.env.NODE_DISABLE_COMPILE_CACHE !== '1')
      throw new Error('Build and explicitly provision native quality tools before browser validation.');
    // Load the actual matching packaged runtime/helper, not source-mode substitutes.
    const built = await loadPackagedExecutionFixture();
    const fixture = await built.executionProductionFixture(0, nativeCase === 'timeout', {
      language: 'typescript', fixture: nativeCase === 'timeout' ? 'clean' : nativeCase, slowNative: nativeCase === 'timeout',
    });
    try {
      await fixture.run();
      const outcome = nativeCase === 'clean' ? 'clean' : nativeCase === 'defect' ? 'findings'
        : nativeCase === 'timeout' ? 'timed_out' : 'analysis_failed';
      await seedTokenBeforeNavigation(page, fixture.token);
      await page.goto(`${fixture.origin}/cards/project?facet=records`);
      const report = page.getByTestId('facet-records').locator('.document-frame').filter({
        has: page.getByRole('heading', { level: 3, name: 'check-report.md', exact: true }),
      });
      await expect(report).toContainText(`Action output · code-quality.typescript.eslint · returned-text · check · ${outcome}`);
      await expect(report).toContainText('not product acceptance');
      await expect(report).toContainText('omitted findings:0');
      await report.getByRole('button', { name: 'History', exact: true }).click();
      await report.getByRole('button', { name: 'v1 · accepted', exact: true }).click();
      await expect(report.locator('.selected-record')).toContainText('returned-text');
      const workLink = report.getByRole('link', { name: 'findings.json', exact: true }).first();
      await expect(workLink).toBeVisible();
      await workLink.click();
      await expect(page).toHaveURL(/\/files/);
      await expect(page.locator('body')).toContainText('findings.json');
      await page.goto(`${fixture.origin}/cards/project?facet=executions`);
      const detailRequest = page.waitForResponse((response) => /\/api\/cards\/project\/executions\/[^/]+$/.test(response.url()));
      await page.getByTestId('card-executions').getByRole('button', { name: /node check.*invocation_started/ }).click();
      const response = await detailRequest;
      expect(response.status()).toBe(200);
      expect(response.request().headers().authorization).toBe(`Bearer ${fixture.token}`);
      const detail = page.getByTestId('execution-detail');
      await expect(detail).toContainText('code-quality.typescript.eslint · contract v1');
      await detail.getByRole('button', { name: /report\.md$/, exact: false }).first().click();
      await expect(page.getByTestId('execution-file-preview')).toContainText('not product acceptance');
      await page.screenshot({ path: testInfo.outputPath(`quality-${outcome}.png`), fullPage: true });
    } finally { await fixture.close(); }
  });
}

test('cancelled real quality action shows no accepted report or assessment', async ({ page }) => {
  if (!process.env.SAIVAGE_QUALITY_NATIVE_ROOT || process.env.NODE_DISABLE_COMPILE_CACHE !== '1')
    throw new Error('Explicit native prerequisites required.');
  const built = await loadPackagedExecutionFixture();
  const fixture = await built.executionProductionFixture(0, false, { language: 'javascript', fixture: 'clean', slowNative: true });
  try {
    expect((await postStartProject(fixture.origin, fixture.token)).status).toBe(200);
    await waitFor(() => existsSync(join(fixture.root, 'fixtures/native-entered')), 'native action entry');
    await fixture.app.server.runtimeApplication.runtimeApi.stopProject();
    await seedTokenBeforeNavigation(page, fixture.token);
    await page.goto(`${fixture.origin}/cards/project?facet=records`);
    await expect(page.getByTestId('facet-records')).not.toContainText('Action output · code-quality');
    expect(fixture.assessmentRequest()).toBeNull();
    await page.goto(`${fixture.origin}/cards/project?facet=executions`);
    await page.getByTestId('card-executions').getByRole('button', { name: /node check.*invocation_started/ }).click();
    await expect(page.getByTestId('execution-detail')).toContainText('cancelled');
  } finally { await fixture.close(); }
});
