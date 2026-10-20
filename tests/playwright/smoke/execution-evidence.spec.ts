import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { executionProductionFixture, executionReport } from '../../helpers/execution-production-fixture.js';
import { redactTextForOutbound } from '../../../src/redaction/index.js';
import { appendCardExecutions } from '../../../src/persistence/card-execution-log.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';
import { parseOperatorResponse } from '../../../src/contracts/index.js';
import { cardExecutionFile } from '../../../src/persistence/layout.js';
import {
  invokeObservationPlugin,
  observationCanaries,
  observationInputs,
  observationOutputs,
} from '../../helpers/execution-observation-fixture.js';

test.describe.configure({ timeout: 90_000, retries: 0 });

test('compiled plugin observations render the actual authenticated detail result without secret scalar/list values', async ({ page }) => {
  const fixture = await executionProductionFixture();
  try {
    // A trusted test-local invocation supplies an explicitly compiled plugin without changing
    // shipped registration or asking a provider to invoke an unsupported workflow operation.
    const { invocation, received, selected } = await invokeObservationPlugin(fixture.root);
    expect(received).toEqual([observationInputs]);
    expect(selected.routeId).toBe('original-secret-value');
    expect(invocation.result.values).toEqual(observationOutputs);
    const path = cardExecutionFile(fixture.root, 'project');
    const raw = readFileSync(path);
    await seedTokenBeforeNavigation(page, fixture.token);
    await page.goto(`${fixture.origin}/cards/project?facet=executions`);
    const responsePromise = page.waitForResponse((response) =>
      response.url() === `${fixture.origin}/api/cards/project/executions/${invocation.invocationId}` &&
      response.request().method() === 'GET',
    );
    await page.getByTestId('card-executions').getByRole('button', { name: /named-observations.*invocation_started/u }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(response.request().headers().authorization).toBe(`Bearer ${fixture.token}`);
    const detail = parseOperatorResponse('cards.executions.get', 200, await response.json());
    const rendered = page.getByTestId('execution-detail').locator('h4 + pre');
    await expect(rendered).toHaveText(JSON.stringify({ input: detail.input, values: detail.values }, null, 2));
    const observations = JSON.parse((await rendered.textContent())!);
    for (const side of ['input', 'values'] as const) {
      const original = side === 'input' ? observationInputs : observationOutputs;
      expect(observations[side]).toEqual(expect.arrayContaining([
        { name: 'api_token', type: 'string', value: '[REDACTED]' },
        { name: 'access_token', type: 'strings', value: ['[REDACTED]', '[REDACTED]'] },
        { name: 'count_secret', type: 'integer', value: 0 },
        { name: 'enabled_secret', type: 'boolean', value: false },
        { name: 'empty_secret', type: 'strings', value: [] },
        { name: 'label', type: 'string', value: original.label },
        { name: 'labels', type: 'strings', value: original.labels },
        { name: 'count', type: 'integer', value: original.count },
        { name: 'enabled', type: 'boolean', value: true },
        { name: 'empty', type: 'strings', value: [] },
      ]));
    }
    for (const canary of [...observationCanaries.input, ...observationCanaries.output]) {
      expect(raw.toString()).toContain(canary);
      await expect(page.getByTestId('execution-detail')).not.toContainText(canary);
    }
    expect(readFileSync(path)).toEqual(raw);
    expect(fixture.counts()).toEqual({ workflowCalls: 0, providerCalls: 0 });
  } finally {
    await fixture.close();
  }
});

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
    await expect(page.getByTestId('execution-file-preview')).toContainText('你好世界🌍🚀😀');
    await expect(page.getByTestId('execution-file-preview')).not.toContainText(
      'stdout-record-private-canary',
    );
    await expect
      .poll(() => page.getByTestId('execution-file-preview').textContent())
      .toBe(redactTextForOutbound(executionReport));
    const download = page.waitForEvent('download');
    await detail
      .getByRole('button', { name: 'Download redacted text', exact: true })
      .first()
      .click();
    const downloaded = await download;
    expect(downloaded.suggestedFilename()).toBe('execution-output.txt');
    const downloadedText = readFileSync((await downloaded.path())!, 'utf8');
    expect(downloadedText).toContain('ACTUAL-ACTION-OUTPUT');
    expect(downloadedText).not.toContain('stdout-record-private-canary');
    expect(downloadedText).toBe(redactTextForOutbound(executionReport));
    expect(downloadedText.startsWith('\uFEFF')).toBe(true);
    expect(downloadedText).toContain('\r\n你好\r\n你好世界🌍🚀😀\r\n');
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
    await page.goto(`${fixture.origin}/cards/project?facet=records`);
    const report = page.getByTestId('facet-records').locator('.document-frame').filter({ hasText: 'check-report.md' });
    await expect(report).toContainText('Shell stdout · shell.run · check · passed');
    await expect(report.getByRole('link', { name: 'Latest accepted v1' })).toBeVisible();
    await expect(report).not.toContainText('stdout-record-private-canary');
  } finally {
    await fixture.close();
  }
});

for (const [outcome, exitCode, deadline] of [['failed', 9, false], ['timed_out', 0, true]] as const) {
  test(`real stdout record displays ${outcome} provenance without an agent verdict or draft attribution`, async ({ page }, testInfo) => {
    const fixture = await executionProductionFixture(exitCode, deadline);
    try {
      await fixture.run();
      await seedTokenBeforeNavigation(page, fixture.token);
      await page.goto(`${fixture.origin}/cards/project?facet=records`);
      const report = page.getByTestId('facet-records').locator('.document-frame').filter({ hasText: 'check-report.md' });
      await expect(report).toContainText(`Shell stdout · shell.run · check · ${outcome}`);
      await expect(report).toContainText('ACTUAL-ACTION-OUTPUT');
      await expect(report).not.toContainText('stdout-record-private-canary');
      await expect(report).not.toContainText('DISTINCT-STDERR-ONLY');
      await expect(report.getByRole('link', { name: 'Latest accepted v1' })).toBeVisible();
      await report.getByRole('button', { name: 'History', exact: true }).click();
      await report.getByRole('button', { name: 'v1 · accepted', exact: true }).click();
      await expect(report.locator('.selected-record')).toContainText(`Shell stdout · shell.run · check · ${outcome}`);
      await expect(report.locator('.record-diff')).toContainText('Current record revision');
      await page.screenshot({ path: testInfo.outputPath(`stdout-record-${outcome}.png`), fullPage: true });
      if (!deadline) {
        fixture.cards.setStatus('project', 'changed');
        await fixture.run();
        await page.reload();
        await expect(report.getByRole('link', { name: 'Latest accepted v2' })).toBeVisible();
        await report.getByRole('button', { name: 'History', exact: true }).click();
        await expect(report.locator('.record-history li')).toHaveCount(2);
        await report.getByRole('button', { name: 'v1 · accepted', exact: true }).click();
        await expect(report.locator('.selected-record')).toContainText('Selected accepted document v1');
        await expect(report.locator('.record-diff')).toContainText('Current record revision');
        await expect(report.locator('.record-diff .code-block pre')).toHaveText('');
      }
      fixture.cards.openRecord('project', 'check-report.md');
      fixture.cards.editRecord('project', 'check-report.md', 'Independent unfinished agent draft');
      await page.reload();
      await expect(report).toContainText('Independent unfinished agent draft');
      await expect(report).toContainText(`Draft for v${deadline ? 2 : 3}`);
      await expect(report.getByText(`Shell stdout · shell.run · check · ${outcome}`, { exact: true })).not.toBeVisible();
      await report.getByText('Prior accepted content', { exact: true }).click();
      await expect(report.getByText(`Shell stdout · shell.run · check · ${outcome}`, { exact: true })).toBeVisible();
    } finally { await fixture.close(); }
  });
}
