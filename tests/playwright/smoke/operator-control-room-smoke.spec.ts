import { expect, test } from '@playwright/test';
import { installOperatorRestRoutes, smokeCardId } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, seedTokenBeforeNavigation, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

const syntheticToken = 'synthetic-playwright-token';

test('operator control room smoke walks browser routes with REST fixtures and WebSocket shim', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required'); const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await seedTokenBeforeNavigation(page, syntheticToken); await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/dashboard')));

  await expect(page.getByText('Dashboard').first()).toBeVisible();
  await expect(page.locator('.analyst-pane-project-name')).toHaveText('project');
  await expect(page.getByRole('region', { name: 'Runtime Console' })).toBeVisible();
  await expect(page.locator('.status-section').filter({hasText:'Runtime Status'}).locator('.status-item').filter({hasText:'Status'}).locator('.status-value')).toHaveText('running'); await expect(page.locator('.mission-active-link')).toHaveText('Synthetic dashboard smoke card'); await expect(page.getByTestId('dashboard-child-of-goal-panel').locator('.list-empty')).toHaveText('none');
  await expect(page.getByText(syntheticToken)).toHaveCount(0);

  await expect.poll(async () => page.evaluate(() => window.__saivageWsFixture?.sockets.length ?? 0)).toBeGreaterThan(0);
  await expect(page.getByText(/Live updates connected/i).first()).toBeVisible();

  await expect(page.locator('.pause-chip')).toHaveCount(0);

  await page.getByText('Cards').first().click();
  await expect(page).toHaveURL(/\/cards$/);
  await expect(page.getByText('Synthetic dashboard smoke card').first()).toBeVisible();
  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto(`/cards/${smokeCardId}`)));
  await expect(page.getByText('Card Detail').first()).toBeVisible();
  const detail=page.getByRole('region',{name:'Card detail'}); const hi=detail.getByTestId('card-detail-highlight'); await expect(hi.locator('.card-entity__name')).toHaveText('Synthetic dashboard smoke card'); await expect(hi.locator('.card-entity__type')).toHaveText('Code'); await expect(hi.locator('.status-badge')).toContainText('done'); await expect(hi.locator('.ori-key').first()).toHaveText('v3'); const result=detail.locator('.section').filter({has:page.getByRole('heading',{name:'Result',exact:true})}); const details=result.locator('details'); await expect(details).not.toHaveAttribute('open',''); await result.locator('summary').click(); await expect(details).toHaveAttribute('open',''); await expect(result.locator('pre')).toContainText('"kind": "workflow-result"'); await expect(result.locator('pre')).toContainText('"summary": "synthetic result"');

  await page.getByText('Agents').first().click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByText('analyst').first()).toBeVisible();
  await expect(page.getByText('planner').first()).toBeVisible();
  await page.locator('.session-card').first().click();
  await expect(page.locator('.detail-header-bar')).toContainText('agent:analyst:global');
  await expect(page.locator('[data-testid="round-card"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="round-card"]').first()).toContainText('Synthetic agent transcript.');
  const ps=page.locator('.role-section').filter({has:page.locator('.role-heading',{hasText:'planner'})}); const pc=ps.locator('.session-card'); await expect(pc).toHaveCount(1); await expect(pc.locator('.session-scope')).toHaveText('card'); await expect(pc.locator('.status-badge')).toHaveCount(0); await expect(pc.getByRole('button',{name:'Synthetic Project'})).toBeVisible(); await pc.click(); await expect(page).toHaveURL(/\/agents\/agent:planner:project$/); await expect(page.locator('.detail-header-bar')).toContainText('agent:planner:project');

  await page.getByText('Files').first().click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByText('plan.json')).toBeVisible();
  await page.getByText('plan.json').click();
  await expect(page.getByText('operator-playwright-smoke')).toBeVisible();

  await page.getByText('Debug').first().click();
  await expect(page).toHaveURL(/\/debug$/);
  await expect(page.getByText('Timeline').first()).toBeVisible();
  await page.getByText('Errors').first().click();
  const errorGroup=page.locator('.error-source-group').filter({has:page.getByRole('heading',{level:4,name:'planner-smoke (1)',exact:true})}); await expect(errorGroup).toHaveCount(1); const errorItem=errorGroup.locator(':scope > .error-item'); await expect(errorItem).toHaveCount(1); await expect(errorItem.locator(':scope > .error-message')).toHaveText('Synthetic provider failure redacted'); const detailCode=errorItem.locator(':scope > .code-block .code-block__code'); await expect(detailCode).toHaveCount(1); const detailText=await detailCode.textContent(); expect(detailText).not.toBeNull(); expect(JSON.parse(detailText as string)).toEqual({phase:'planner-smoke',error_message:'Synthetic provider failure redacted'});

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/dashboard'))); await waitForRuntimePair(page, async()=>page.evaluate(()=>window.__saivageWsFixture?.emitRuntimeUpdate())); await expect(page.getByTestId('dashboard-child-of-goal-panel').locator('.list-empty')).toHaveText('none');

  await failures.during('full-document-navigation', () => waitForRuntimePair(page, () => page.goto('/route-that-does-not-exist')));
  await expect(page.getByRole('heading', { name: /404 — Not found/i })).toBeVisible();
  await expect(page.getByText('/route-that-does-not-exist')).toBeVisible();

  expect(rest.unknown).toEqual([]);
  assertPreviewRequestFailures(failures, baseURL, ['full-document-navigation']);
  expect(pageErrors).toEqual([]);
});
