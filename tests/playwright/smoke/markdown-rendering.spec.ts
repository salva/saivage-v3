import { expect, test, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeCardId } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';

// Real built UI, disposable API fixtures only: no provider or generated-state work.
const session = `agent:executor:${smokeCardId}`;
const segment = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-10-08T12:00:00.000Z';
const reference = `[[card:${smokeCardId}|Next card]]`;
const nbspDestination = `[](${'\u00a0'.repeat(100)}`;
const source = [
  '# Markdown objective',
  '**Strong** and *emphasized* benign text.',
  '- First\n- Second',
  '| Item | State |\n| --- | --- |\n| Example | ready |',
  '[Safe HTTPS](https://example.test/path_(part)) and [Reference][safe].',
  '[safe]: https://example.test/reference',
  reference,
  `\`${reference}\``,
  `\`\`\`text\n${reference}\n\`\`\``,
  nbspDestination,
  '<script>window.markdownInjected=true</script>',
  '<img alt="safe image" src="data:image/png;base64,iVBORw0KGgo=" onerror="window.markdownInjected=true">',
  '<span onclick="window.markdownInjected=true">Safe span</span>',
  '[Unsafe](javascript:window.markdownInjected=true)',
  '<a href="java&#x73;cript:window.markdownInjected=true">Encoded unsafe</a>',
].join('\n\n');

async function expectMarkdown(owner: Locator) {
  await expect(owner.getByRole('heading', { name: 'Markdown objective', exact: true })).toBeVisible();
  await expect(owner.locator('strong')).toHaveText('Strong');
  await expect(owner.locator('em')).toHaveText('emphasized');
  await expect(owner.locator('ul li')).toHaveText(['First', 'Second']);
  await expect(owner.locator('thead th')).toHaveText(['Item', 'State']);
  await expect(owner.locator('tbody td')).toHaveText(['Example', 'ready']);
  await expect(owner.getByRole('link', { name: 'Safe HTTPS', exact: true })).toHaveAttribute('href', 'https://example.test/path_(part)');
  await expect(owner.getByRole('link', { name: 'Reference', exact: true })).toHaveAttribute('href', 'https://example.test/reference');
  await expect(owner.getByRole('link', { name: 'Next card', exact: true })).toHaveAttribute('href', `/cards/${smokeCardId}`);
  expect(await owner.locator('code').allTextContents()).toEqual([reference, `${reference}\n`]);
  await expect(owner.locator('code a')).toHaveCount(0);
  // textContent, not Playwright's whitespace-normalizing text matcher, preserves NBSP.
  expect(await owner.locator('p').allTextContents()).toContain(nbspDestination);
  await expect(owner.locator('script, [onerror], [onclick]')).toHaveCount(0);
  await expect(owner.locator('a')).toHaveCount(5);
  for (const label of ['Unsafe', 'Encoded unsafe']) {
    const anchor = owner.locator('a').filter({ hasText: new RegExp(`^${label}$`) });
    await expect(anchor).toHaveCount(1);
    expect(await anchor.getAttribute('href')).toBeNull();
  }
  await expect(owner.locator('img')).toHaveAttribute('alt', 'safe image');
  await expect(owner).toContainText('benign text.');
  await expect(owner.locator('span')).toHaveText('Safe span');
}

test('conversation and full record content share sanitized GFM and real Cards navigation', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required');
  const pageErrors: string[] = [];
  const unexpectedRequests: string[] = [];
  const badResponses: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) {
      badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  // Refuse unexpected external traffic instead of allowing a canary to contact it.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL).origin) {
      unexpectedRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => { (window as unknown as { markdownInjected: boolean }).markdownInjected = false; });
  await seedTokenBeforeNavigation(page, 'synthetic-markdown-rendering-token');
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  await page.route('**/api/agents/*/conversation**', async route => {
    const url = new URL(route.request().url());
    if (decodeURIComponent(url.pathname) !== `/api/agents/${session}/conversation`) return route.fallback();
    const entry = { id: 'markdown-prose', session_id: session, role: 'assistant', kind: 'text', content: source,
      context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
      round_id: 'r-assistant-11111111111141118111111111111111', message_index: 0, block_index: 0, timestamp };
    const body = parseOperatorResponse('agents.conversation', 200, { session_id: session, segment_id: segment,
      segment_version: 1, segment_context: null, entries: url.searchParams.has('since') ? [] : [entry],
      cursor: { segment_id: segment, segment_version: 1, message_id: entry.id } });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(`**/api/cards/${smokeCardId}/records/brief.md`, async route => {
    const body = parseOperatorResponse('cards.records.get', 200, { card_id: smokeCardId, record: {
      head_id: segment, name: 'brief.md', revision: 1, current_url: `record:///brief.md?card=${smokeCardId}`,
      accepted_version_url: `record:///brief.md?card=${smokeCardId}&v=1`, state: 'closed',
      accepted: { source_version: 1, source_entry_id: segment, committed_at: timestamp, writer_agent: 'analyst',
        card_version_seq: 1, card_history_version: 1, card_history_entry_id: segment, content: source,
        content_sha256: createHash('sha256').update(source).digest('hex'), size_bytes: Buffer.byteLength(source) },
      draft: null, effective_content_source: 'accepted',
    } });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(`/agents/${session}`);
  const conversation = page.getByTestId('route-cockpit').locator('[data-entry-id="markdown-prose"] .markdown-text');
  await expectMarkdown(conversation);
  expect(await page.evaluate(() => (window as unknown as { markdownInjected: boolean }).markdownInjected)).toBe(false);
  await conversation.getByRole('link', { name: 'Next card', exact: true }).click();
  await expect(page).toHaveURL(`/cards/${smokeCardId}`);
  const cockpit = page.getByTestId('route-cockpit');
  await expect(cockpit.getByTestId('card-flow-id')).toHaveText(smokeCardId);
  await expect(cockpit.locator('.tree-node.selected')).toContainText('Synthetic dashboard smoke card');
  const disclosure = cockpit.locator('.record-preview[data-record-name="brief.md"] .record-full-content');
  await expect(disclosure).not.toHaveAttribute('open', '');
  await disclosure.locator(':scope > summary').click();
  await expect(disclosure).toHaveAttribute('open', '');
  await expectMarkdown(disclosure.locator('.markdown-text'));
  await cockpit.getByTestId('cockpit-facet-nav').getByRole('link', { name: 'Records & History', exact: true }).click();
  const record = page.getByTestId('facet-records').locator('.document-frame').filter({ has: page.getByRole('heading', { name: 'brief.md', exact: true }) });
  await expectMarkdown(record.locator('.markdown-text'));
  expect(await page.evaluate(() => (window as unknown as { markdownInjected: boolean }).markdownInjected)).toBe(false);
  expect(pageErrors).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
  expect(badResponses).toEqual([]);
  expect(rest.unknown).toEqual([]);
});
