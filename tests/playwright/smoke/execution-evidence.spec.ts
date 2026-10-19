import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { executionProductionFixture } from '../../helpers/execution-production-fixture.js';
import { appendCardExecutions } from '../../../src/persistence/card-execution-log.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';

test.describe.configure({ timeout: 90_000, retries: 0 });

test('real production server: action and hook evidence, confidential file download, real conversation retained', async ({
  page,
}) => {
  const fixture = await executionProductionFixture();
  try {
    await fixture.run();
    await seedTokenBeforeNavigation(page, fixture.token);
    await page.goto(`${fixture.origin}/cards/project?facet=executions`);
    const facet = page.getByTestId('card-executions');
    await expect(facet).toBeVisible();
    await expect(facet.getByRole('button', { name: /invocation_started/u })).toHaveCount(2);
    await facet.getByRole('button', { name: /node check.*invocation_started/u }).click();
    const detail = page.getByTestId('execution-detail');
    await expect(detail).toContainText('shell.run · contract v1');
    await expect(detail).toContainText('builtin: shell');
    await expect(detail).toContainText('node check');
    await expect(detail).not.toContainText('synthetic-env-not-public');
    await expect(detail).toContainText('absent-report.txt (no file link)');
    await expect(
      detail.getByRole('button', { name: 'absent-report.txt', exact: true }),
    ).toHaveCount(0);
    await detail.getByRole('button', { name: 'stdout', exact: true }).first().click();
    await expect(page.getByTestId('execution-file-preview')).toContainText('ACTUAL-ACTION-OUTPUT');
    const download = page.waitForEvent('download');
    await detail
      .getByRole('button', { name: 'Download redacted text', exact: true })
      .first()
      .click();
    expect((await download).suggestedFilename()).toBe('execution-output.txt');
    await facet
      .getByRole('button', { name: /after_activation_commit hook.*invocation_started/u })
      .click();
    await expect(detail).toContainText(
      'card hook after_activation_commit · committed done · artifact',
    );
    await detail.getByRole('button', { name: 'hook-report.txt', exact: true }).click();
    await expect(page.getByTestId('execution-file-preview')).toContainText('mutable hook report');
    await expect(detail).toContainText('mutable current workspace source (not historical content)');

    // Deliberately authored incomplete evidence, not a fake live invocation or provider turn.
    appendCardExecutions(fixture.root, 'project', [
      {
        kind: 'invocation_started',
        row_id: randomUUID(),
        invocation_id: randomUUID(),
        card_id: 'project',
        timestamp: new Date().toISOString(),
        operation: 'fixture.inspect',
        contract_version: 1,
        provider: { kind: 'plugin', name: 'fixture' },
        binding: {
          kind: 'node',
          activation_id: randomUUID(),
          node_id: 'incomplete-observation',
          ordinal: 8,
        },
        input: [],
        config: [],
        shell: null,
      },
    ]);
    await facet.getByRole('button', { name: 'Refresh evidence' }).click();
    await facet.getByRole('button', { name: /incomplete-observation/u }).click();
    await expect(detail).toContainText('no completion retained; effects unknown');
    await expect(detail).not.toContainText('running');
    await page
      .getByTestId('cockpit-facet-nav')
      .getByRole('link', { name: 'Conversations', exact: true })
      .click();
    await expect(page.getByTestId('card-executions')).toHaveCount(0);
    await expect(page.getByText('planner', { exact: true }).first()).toBeVisible();
    expect(fixture.counts().workflowCalls).toBe(2);
  } finally {
    await fixture.close();
  }
});
