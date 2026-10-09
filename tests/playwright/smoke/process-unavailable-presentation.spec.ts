import { expect, test } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { unavailableProcess } from '../../../web/src/__tests__/fixtures/process-unavailable.js';

test('actual process view transports independent unavailable facts and refreshes without control authority', async ({ page }) => {
  await installOperatorWebSocketShim(page);
  await installOperatorRestRoutes(page);
  let unavailable = false;
  await page.route('**/api/processes', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(parseOperatorResponse('processes.list', 200, {
      processes: [{ ...unavailableProcess, status: unavailable ? 'unavailable' : 'running', evidence: { ...unavailableProcess.evidence, group: unavailable ? 'unverifiable' : 'tracked', stdout: unavailable ? 'open' : 'closed' } }],
    })),
  }));
  await page.goto('/system?section=processes');
  const panel = page.locator('.processes-list');
  await expect(panel).toContainText('Awaiting group/output settlement');
  await expect(panel).toContainText('Closed without observed EOF · Capture failed');
  unavailable = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(panel).toContainText('Evidence unavailable');
  await expect(panel).toContainText('Leader exit observed:');
  await expect(panel).toContainText('code 1');
  await expect(panel).toContainText('Stream open · Capture failed: synthetic stdout capture error');
  await expect(panel).toContainText('EOF observed · Capture failed: synthetic stderr capture error');
  await expect(panel).toContainText('Later activations cannot take ownership');
  await expect(panel.getByRole('button', { name: 'Browse', exact: true })).toHaveCount(2);
  await expect(panel).toContainText(unavailableProcess.logs.stdout!);
  await expect(panel.getByRole('button', { name: /terminate|kill|reconcile/i })).toHaveCount(0);
  await expect(panel).not.toContainText('Ended:');
});
