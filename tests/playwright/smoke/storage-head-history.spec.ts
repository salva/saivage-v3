import { expect, test, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { parseOperatorResponse, type OperatorApiOperationId } from '../../../src/contracts/operator-api.js';
import { installOperatorRestRoutes, smokeCardId, smokeOperatorCard } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { assertPreviewRequestFailures, observePreviewRequestFailures, waitForRuntimePair } from './fixtures/operator-preview-sync.js';

test.use({ trace: 'on' });
const now = '2026-10-02T12:00:00.000Z';
const firstId = '11111111-1111-4111-8111-111111111111';
const fourthId = '44444444-4444-4444-8444-444444444444';
const acceptedId = '55555555-5555-4555-8555-555555555555';
const recordName = 'brief.md';
const currentUrl = `record:///${recordName}?card=${smokeCardId}`;
const acceptedUrl = `${currentUrl}&v=1`;
const ordinaryLocator = `card:///${smokeCardId}?v=1#entry=${firstId}`;
const draftText = 'Current unfinished draft: investigate the new selection.';
const deliveredText = 'Delivered operator notification retained in the conversation.';
const acceptedText = 'Exact accepted objective, observed at card mutation revision three.';
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const accepted = {
  source_version: 1, source_entry_id: acceptedId, committed_at: now, writer_agent: 'analyst',
  card_version_seq: 3, card_history_version: 1, card_history_entry_id: firstId,
  content: acceptedText, content_sha256: hash(acceptedText), size_bytes: Buffer.byteLength(acceptedText),
};
const first = {
  id: smokeCardId, type: 'code', title: 'Exact ordinary snapshot one', version_seq: 1,
  lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
  child_membership: [], active_child_order: [], subtype: null, priority: 0, urgency: 'normal', created_by: 'analyst',
  created_at: now, updated_at: now, assigned_to: null, depends_on: [], metrics: null, estimate: null,
  started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null,
  status_text_author_session_id: null, latest_self_report: null, metadata: null,
};
const fourth = { ...first, title: 'Ordinary snapshot four', version_seq: 4 };
const catalogEntry = (version: number, entry_id: string) => ({ version, entry_id, published_at: now, artifact_kind: 'card-version', change: null });

function json(route: Route, operation: OperatorApiOperationId, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(parseOperatorResponse(operation, status, body)) });
}

test('built UI distinguishes mutable heads, sparse ordinary history and accepted provenance', async ({ page, context, baseURL }, testInfo) => {
  if (!baseURL) throw new Error('baseURL required');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const failures = observePreviewRequestFailures(page, baseURL);
  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  const expectedMissingResponses: string[] = [];
  const expectedMissingCardResponses: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    // Files resolves a deep-linked virtual file by trying it as a directory first.
    const expectedFileProbe = response.status() === 400 && url.pathname === '/api/files' && url.searchParams.get('path')?.includes('card.json');
    const recordPrefix = `/api/cards/${smokeCardId}/records/${recordName}`;
    const expectedRecordMiss = response.request().method() === 'GET' && response.status() === 404 && url.origin === new URL(baseURL).origin &&
      ((url.pathname === `${recordPrefix}/versions/3` && url.search === '') ||
        (url.pathname === `${recordPrefix}/diff` && url.searchParams.get('from') === '3' && url.searchParams.get('to') === 'current' && url.searchParams.get('view') === 'effective' && [...url.searchParams].length === 3));
    const cardPrefix = `/api/cards/${smokeCardId}`;
    const expectedCardMiss = response.request().method() === 'GET' && response.status() === 404 && url.origin === new URL(baseURL).origin &&
      ((url.pathname === `${cardPrefix}/history/3` && url.search === '') ||
        (url.pathname === `${cardPrefix}/diff` && url.searchParams.get('from') === '3' && url.searchParams.get('to') === 'current' && [...url.searchParams].length === 2));
    if (expectedRecordMiss) expectedMissingResponses.push(`${url.pathname}${url.search}`);
    if (expectedCardMiss) expectedMissingCardResponses.push(`${url.pathname}${url.search}`);
    if (url.pathname.startsWith('/api/') && response.status() >= 400 && !expectedFileProbe && !expectedRecordMiss && !expectedCardMiss) badResponses.push(`${response.status()} ${url.pathname}`);
  });
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  const sessionId = `agent:executor:${smokeCardId}`;
  await page.route('**/api/agents/*/conversation{,?**}', async (route) => {
    if (decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!) !== sessionId) return route.fallback();
    return json(route, 'agents.conversation', {
      session_id: sessionId, segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, segment_context: null,
      entries: [{ id: 'delivered-notice', session_id: sessionId, role: 'user', kind: 'text', content: deliveredText,
        context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
        round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: now }],
      cursor: { segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, message_id: 'delivered-notice' },
    });
  });
  let revision = 3;
  const namespace = `.saivage/cards/project/children/${smokeCardId.slice(5)}`;
  await page.route(`**/api/cards/${smokeCardId}{,/**,?**}`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    requests.push(`${path}${url.search}`);
    const prefix = `/api/cards/${smokeCardId}`;
    if (path === prefix) return json(route, 'cards.get', { card: { ...smokeOperatorCard, title: revision === 3 ? first.title : fourth.title, lifecycle: first.lifecycle, version_seq: revision, updated_at: now } });
    if (path === `${prefix}/records`) return json(route, 'cards.records.list', { card_id: smokeCardId, records: [{ name: recordName, format: 'markdown', schema: 'brief.v1', bootstrap: true, current: { head_id:firstId, revision: 3, current_url: currentUrl, accepted_version_url: acceptedUrl, state: 'open', accepted_source_version: 1, draft_present: true } }] });
    if (path === `${prefix}/records/${recordName}`) return json(route, 'cards.records.get', { card_id: smokeCardId, record: { head_id:firstId, name: recordName, revision: 3, current_url: currentUrl, accepted_version_url: acceptedUrl, state: 'open', accepted, draft: { opened_at: now, updated_at: now, content: draftText, content_sha256: hash(draftText) }, effective_content_source: 'draft' } });
    if (path === `${prefix}/records/${recordName}/history`) return json(route, 'cards.records.history.list', { card_id: smokeCardId, name: recordName, versions: [{ version: 1, entry_id: acceptedId, published_at: now, version_url: acceptedUrl }], total: 1 });
    if (path === `${prefix}/records/${recordName}/versions/1`) return json(route, 'cards.records.versions.get', { card_id: smokeCardId, name: recordName, version: 1, version_url: acceptedUrl, entry_id: acceptedId, published_at: now, artifact: { published_at: now, accepted } });
    const missingRecordVersion = { error: 'historical_version_not_found', resource: 'authored_record', owner_id: `${smokeCardId}/${recordName}`, version: 3 };
    if (path === `${prefix}/records/${recordName}/versions/3`) return json(route, 'cards.records.versions.get', missingRecordVersion, 404);
    if (path === `${prefix}/records/${recordName}/diff`) {
      expect(url.searchParams.get('to')).toBe('current');
      expect(url.searchParams.get('view')).toBe('effective');
      if (url.searchParams.get('from') === '3') return json(route, 'cards.records.diff', missingRecordVersion, 404);
      expect(url.searchParams.get('from')).toBe('1');
      return json(route, 'cards.records.diff', { card_id: smokeCardId, name: recordName, from: 1, to: { kind: 'current', head_id:firstId, revision: 3, accepted_version: 1 }, view: 'effective', hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: [`-${acceptedText}`, `+${draftText}`] }] });
    }
    if (path === `${prefix}/history`) return json(route, 'cards.history.list', { card_id: smokeCardId, versions: revision === 3 ? [catalogEntry(1, firstId)] : [catalogEntry(1, firstId), catalogEntry(4, fourthId)], total: revision === 3 ? 1 : 2 });
    const missingCardVersion = { error: 'historical_version_not_found', resource: 'card', owner_id: smokeCardId, version: 3 };
    if (path === `${prefix}/history/3`) return json(route, 'cards.history.get', missingCardVersion, 404);
    if (path === `${prefix}/history/1` || path === `${prefix}/history/4`) {
      const version = Number(path.split('/').at(-1));
      return json(route, 'cards.history.get', { card_id: smokeCardId, version, entry_id: version === 1 ? firstId : fourthId, published_at: now, artifact: { kind: 'card-version', card: version === 1 ? first : fourth, change: null } });
    }
    if (path === `${prefix}/diff`) {
      expect(url.searchParams.get('to')).toBe('current');
      if (url.searchParams.get('from') === '3') return json(route, 'cards.diff', missingCardVersion, 404);
      return json(route, 'cards.diff', { card_id: smokeCardId, from: Number(url.searchParams.get('from')), to: { kind: 'current', head_id:smokeOperatorCard.head_id, version_seq: revision, history_version: revision === 3 ? 1 : 4 }, diff: [{ field: 'version_seq', before: 1, after: revision }, { field: 'metadata', before: { token: '[redacted]' }, after: null }] });
    }
    return route.fallback();
  });
  await page.route('**/api/files?**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path')!;
    if (path.includes('card.json')) return json(route, 'files.list', { error: 'Path is not a directory', path }, 400);
    if (path !== namespace) return route.fallback();
    return json(route, 'files.list', { path, files: [{ name: 'card.json', path: `${path}/card.json`, type: 'file', size: 500, modifiedAt: now }, { name: recordName, path: `${path}/${recordName}`, type: 'file', size: draftText.length, modifiedAt: now }, { name: 'children', path: `${path}/children`, type: 'directory', modifiedAt: now }] });
  });
  await page.route('**/api/files/content?**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path')!;
    if (!path.startsWith(namespace)) return route.fallback();
    if (path.endsWith(`/${recordName}`)) return json(route, 'files.content', { path, size: Buffer.byteLength(draftText), contentType: 'text/markdown', content: draftText, redacted: true, sensitivity: 'sensitive-redacted', version: 3, modifiedAt: now });
    const historical = path.endsWith('?v=1');
    const content = JSON.stringify(historical ? { format_version: 1, card_id: smokeCardId, kind: 'card-version', version: 1, entry_id: firstId, published_at: now, card: first, change: null } : { kind: 'card-current', head_id:smokeOperatorCard.head_id, card_id: smokeCardId, version_seq: revision, history_version: 4, updated_at: now, card: fourth }, null, 2);
    return json(route, 'files.content', { path, size: Buffer.byteLength(content), contentType: 'application/json', content, redacted: true, sensitivity: 'sensitive-redacted', version: historical ? 1 : revision, modifiedAt: now });
  });

  await waitForRuntimePair(page, () => page.goto(`/cards/${smokeCardId}?facet=records`));
  const facet = page.getByTestId('facet-records');
  await expect(facet.getByText('Current revision 3 · ordinary history v1', { exact: true })).toBeVisible();
  await expect(facet.locator('.history-item')).toHaveCount(1);
  await expect(facet.locator('.history-item')).toContainText('v1');
  await expect(facet.locator('.history-detail')).toContainText('[redacted]');
  await expect(facet.getByText(draftText, { exact: true })).toBeVisible();
  await expect(facet.getByRole('link', { name: 'Latest accepted v1' })).toBeVisible();
  expect((await facet.locator('.exact-value').allTextContents()).join('\n')).not.toContain(`${currentUrl}&v=3`);

  revision = 4;
  const historyReads = requests.filter((path) => path.endsWith('/history')).length;
  await page.evaluate((id) => {
    for (const scope of ['detail', 'history', 'diff']) window.__saivageWsFixture?.emit({ t: 'invalidate', resource: 'cards', scope, card_id: id });
  }, smokeCardId);
  await expect.poll(() => requests.filter((path) => path.endsWith('/history')).length).toBeGreaterThan(historyReads);
  await expect(facet.locator('.history-item')).toHaveCount(2);
  await expect(facet.getByText('Current revision 4 · ordinary history v4', { exact: true })).toBeVisible();
  await facet.locator('.history-item').filter({ hasText: 'v4' }).click();
  await expect(facet.locator('.history-detail')).toContainText('Ordinary snapshot four');
  await page.screenshot({ path: testInfo.outputPath('ordinary-four-current-diff.png'), fullPage: true });

  await facet.getByRole('link', { name: 'Latest accepted v1' }).click();
  const selected = facet.locator('.selected-record');
  await expect(selected).toContainText(acceptedText);
  await expect(selected).toContainText('Observed card mutation revision 3');
  await expect(selected).toContainText('Current record revision 3');
  await selected.getByRole('button', { name: 'Copy selected record locator', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(acceptedUrl);
  await selected.getByRole('button', { name: 'Copy provenance locator', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ordinaryLocator);
  await page.screenshot({ path: testInfo.outputPath('draft-accepted-provenance.png'), fullPage: true });
  await selected.getByRole('link', { name: 'v1', exact: true }).click();
  await expect(facet.locator('.history-detail')).toContainText(first.title);
  await facet.getByRole('button', { name: 'Copy card history locator', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ordinaryLocator);

  await page.getByRole('link', { name: 'Conversations', exact: true }).click();
  await expect(page.getByText(deliveredText, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('delivered-conversation-remains-visible.png'), fullPage: true });

  await waitForRuntimePair(page, () => page.goto(`/cards/${smokeCardId}?facet=records&version=3`));
  await expect(facet.getByRole('alert')).toContainText('historical_version_not_found');
  await expect(facet.locator('.history-detail')).not.toContainText(first.title);
  expect(requests.some((path) => path === `/api/cards/${smokeCardId}/history/3`)).toBe(true);
  await expect.poll(() => expectedMissingCardResponses.length).toBe(2);
  expect(expectedMissingCardResponses.filter((path) => path.endsWith('/history/3'))).toHaveLength(1);
  expect(expectedMissingCardResponses.filter((path) => path.includes('/diff?'))).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('sparse-selector-server-errors.png'), fullPage: true });

  await waitForRuntimePair(page, () => page.goto(`/cards/${smokeCardId}?facet=records&record=${recordName}&version=3`));
  await expect(facet.locator('.record-history-error[role="alert"]')).toContainText('historical_version_not_found');
  await expect(facet.locator('.selected-record')).toHaveCount(0);
  await expect(facet.getByText('Current revision 3 · draft', { exact: true })).toBeVisible();
  await expect(facet.getByText(draftText, { exact: true })).toBeVisible();
  await expect(facet.getByRole('link', { name: 'Latest accepted v1' })).toBeVisible();
  expect(requests.some((path) => path === `/api/cards/${smokeCardId}/records/${recordName}/versions/3`)).toBe(true);
  await expect.poll(() => expectedMissingResponses.length).toBe(2);
  expect(expectedMissingResponses.filter((path) => path.includes('/versions/3'))).toHaveLength(1);
  expect(expectedMissingResponses.filter((path) => path.includes('/diff?'))).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('record-sparse-server-errors.png'), fullPage: true });

  await waitForRuntimePair(page, () => page.goto(`/files?root=meta&path=${encodeURIComponent(namespace)}`));
  await expect(page.getByTestId('files-list')).not.toContainText('mailbox');
  await expect(page.getByTestId('files-list')).not.toContainText('card-head');
  await page.getByTestId('files-list').getByText('card.json', { exact: true }).click();
  await expect(page.getByTestId('files-viewer')).toContainText('card-current');
  await expect(page.getByTestId('files-viewer')).toContainText('history_version');
  await waitForRuntimePair(page, () => page.goto(`/files?root=meta&path=${encodeURIComponent(`${namespace}/card.json?v=1`)}`));
  await expect(page.getByTestId('files-viewer')).toContainText(first.title);
  await expect(page.getByTestId('files-viewer')).not.toContainText('pending_notifications');
  await expect(page.getByTestId('files-viewer')).not.toContainText('mailbox');
  await page.screenshot({ path: testInfo.outputPath('files-exact-ordinary-one.png'), fullPage: true });
  expect(rest.unknown).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(badResponses).toEqual([]);
  assertPreviewRequestFailures(failures);
});
