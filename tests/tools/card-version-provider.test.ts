import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cardVersionToolBinders } from '../../src/tools/card-version-provider.js';
import { invokeTool, llmToolDefinition, type InvocationSurface } from '../../src/tools/invocation.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { cardStreamFile, cardRecordStreamFile } from '../../src/persistence/layout.js';
import { readStrictCanonicalGrowingFile } from '../../src/persistence/growing-file.js';
import { cardArtifactSchema } from '../../src/persistence/canonical-card-artifacts.js';
import { authoredRecordVersionArtifactSchema } from '../../src/persistence/canonical-record-artifacts.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';
import { compileInvocationToolContract } from '../../src/runtime/actors/context/context-blocks.js';
import { settleToolResultForConversation } from '../../src/runtime/actors/llm-delivery-log.js';
import { projectDynamicForOutbound } from '../../src/redaction/dynamic.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import { DISCOVERY_TEXT_PREVIEW_MAX_BYTES, utf8SafePreview } from '../../src/tools/response-packer.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const envelopeBytes = (data: unknown): number => Buffer.byteLength(canonicalJson({ success: true, data }), 'utf8');

function surfaceFor(cards: CardService) {
  return buildInvocationSurfaceFixture('planner', [bindToolProvider('card-version', cardVersionToolBinders, { store: cards })]);
}

function completeSurfaceFor(cards: CardService) {
  return buildInvocationSurfaceFixture('planner', [
    bindToolProvider('card-inspection', cardInspectionToolBinders, { store: cards, cardTypeVocabulary: ['project', 'goal', 'code'] }),
    bindToolProvider('card-version', cardVersionToolBinders, { store: cards }),
  ]);
}

function settleExecution(surface: InvocationSurface, name: string, execution: Awaited<ReturnType<typeof invokeTool>>) {
  const definition = surface.tools.get(name)!;
  return settleToolResultForConversation(
    name,
    compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate),
    { kind: 'executed', execution },
  );
}

function childInput(title: string, tags: string[] = []) {
  return { type: 'code' as const, parent: 'project', title, bootstrap_content: 'Brief', tags, priority: 0, urgency: 'normal' as const, created_by: 'planner' as const, depends_on: [] as string[], related: [] as string[] };
}

describe('card version provider', () => {
  it("returns the selected row's complete carrier from the historical children section", async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-children-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const first = cards.create(childInput('first'));
    const second = cards.create(childInput('second'));
    const parentVersion = cards.read('project')!.version_seq;
    cards.reorderChildren('project', [second.id, first.id]);
    cards.deleteSubtrees([first.id], () => true, 'planner');
    writeFileSync(cardStreamFile(root, first.id), 'child liveness must not be read\n');
    writeFileSync(cardStreamFile(root, second.id), 'child liveness must not be read\n');
    const surface = surfaceFor(cards);

    const execution = await invokeTool(surface, 'get_card_version', {
      card_id: 'project', version: parentVersion, section: 'children', response_bytes: 2048,
    });
    const settled = settleExecution(surface, 'get_card_version', execution);
    const result = settled.providerResult as { data: { entry_id: string; artifact_sha256: string; content: { items: string[] } } };
    expect(result.data.content.items).toEqual([first.id, second.id]);
    expect(settled.evidence).toEqual({
      kind: 'canonical_locator',
      locator: `card:///project?v=${parentVersion}#entry=${result.data.entry_id}`,
      sha256: result.data.artifact_sha256,
    });

    const summary = settleExecution(surface, 'get_card_version', await invokeTool(surface, 'get_card_version', { card_id: 'project', version: parentVersion, section: 'summary' }));
    expect(summary.evidence).toEqual(settled.evidence);
  });

  it('rejects an immutable summary that cannot fit the 512-byte final envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-summary-reject-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create(childInput('oversized-' + 'x'.repeat(1600)));

    await expect(invokeTool(surfaceFor(cards), 'get_card_version', {
      card_id: child.id,
      version: 1,
      section: 'summary',
      response_bytes: 512,
    })).rejects.toThrow("Section 'summary' does not fit the requested response_bytes budget of 512.");
  });

  it('settles a fitting immutable summary with locator evidence and matches current summary and notification projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-summary-parity-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create(childInput('Parity title', ['alpha', 'beta']));
    cards.enqueueNotification(child.id, { id: 'notification-1', content: 'review token=[REDACTED]', created_at: '2026-09-03T10:00:00.000Z' });
    const version = cards.read(child.id)!.version_seq;
    const surface = completeSurfaceFor(cards);
    const responseBytes = 2048;

    const currentSummary = await invokeTestTool(surface, 'get_card', { id: child.id, section: 'summary', response_bytes: responseBytes });
    const immutableSummaryExecution = await invokeTool(surface, 'get_card_version', { card_id: child.id, version, section: 'summary', response_bytes: responseBytes });
    const immutableSummary = settleExecution(surface, 'get_card_version', immutableSummaryExecution);
    expect(immutableSummary.evidence).toMatchObject({
      kind: 'canonical_locator',
      locator: expect.stringMatching(new RegExp(`^card:///${child.id}\\?v=${version}#entry=`)),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(Buffer.byteLength(immutableSummary.settledResultBytes, 'utf8')).toBeLessThanOrEqual(responseBytes);
    expect(immutableSummary.settledResultBytes).toBe(canonicalJson(immutableSummary.providerResult));
    expect((immutableSummary.providerResult as { data: { card: unknown } }).data.card).toEqual((currentSummary.data as { card: unknown }).card);

    const currentNotifications = await invokeTestTool(surface, 'get_card', { id: child.id, section: 'notifications', response_bytes: responseBytes });
    const immutableNotificationExecution = await invokeTool(surface, 'get_card_version', { card_id: child.id, version, section: 'notifications', response_bytes: responseBytes });
    const immutableNotifications = settleExecution(surface, 'get_card_version', immutableNotificationExecution);
    const currentItems = (currentNotifications.data as { content: { items: unknown[] } }).content.items;
    const immutableItems = (immutableNotifications.providerResult as { data: { content: { items: unknown[] } } }).data.content.items;
    expect(immutableItems).toEqual(currentItems);
    expect(Buffer.byteLength(immutableNotifications.settledResultBytes, 'utf8')).toBeLessThanOrEqual(responseBytes);
  });

  it('lists stream row metadata paged by byte budget and reads and diffs exact resulting versions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-tool-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create(childInput('Before'));
    cards.editCard(child.id, { title: 'After' }, 'planner');
    const surface = surfaceFor(cards);

    const listed = await invokeTestTool(surface, 'list_card_versions', { card_id: child.id });
    const listData = listed.data as { observation_sha256: string; versions: { total: number; returned: number; items: Array<{ version: number; entry_id: string; change: unknown }> } };
    expect(listData.versions.total).toBe(2);
    expect(listData.versions.items.map((entry) => entry.version)).toEqual([1, 2]);
    expect(listData.observation_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(envelopeBytes(listed.data)).toBeLessThanOrEqual(32768);
    const streamEntryIds = readStrictCanonicalGrowingFile(cardStreamFile(root, child.id), cardArtifactSchema).map((row) => row.entry_id);
    expect(listData.versions.items.map((entry) => entry.entry_id)).toEqual(streamEntryIds);

    const version = await invokeTool(surface, 'get_card_version', { card_id: child.id, version: 2, section: 'summary' });
    expect(version.evidence).toMatchObject({ kind: 'canonical_locator', locator: `card:///${child.id}?v=2#entry=${(listData.versions.items[1]!.entry_id)}`, sha256: expect.any(String) });
    const versionResult = settleToolActionOutcome(version.providerOutcome).providerResult;
    expect(versionResult).toMatchObject({ success: true, data: { card_id: child.id, version: 2, section: 'summary', card: { title: 'After' } } });
    expect(envelopeBytes((versionResult as { data: unknown }).data)).toBeLessThanOrEqual(32768);

    const diff = await invokeTestTool(surface, 'diff_card_versions', { card_id: child.id, from_version: 1, to_version: 2 });
    const diffData = diff.data as { from_version: number; to_version: number; from_artifact: { artifact_sha256: string }; to_artifact: { artifact_sha256: string }; diff: { content: string; offset_bytes: number; next_offset_bytes: number; total_bytes: number } };
    expect(diffData.from_version).toBe(1);
    expect(diffData.to_version).toBe(2);
    expect(diffData.from_artifact.artifact_sha256).not.toBe(diffData.to_artifact.artifact_sha256);
    expect(diffData.diff.content).toContain('Before');
    expect(diffData.diff.content).toContain('After');
    expect(diffData.diff.next_offset_bytes).toBe(diffData.diff.total_bytes);
    expect(envelopeBytes(diff.data)).toBeLessThanOrEqual(32768);
  });

  it('rejects the removed current pivot and missing exact pivots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-pivots-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create(childInput('Card'));
    const surface = surfaceFor(cards);

    await expect(invokeTestTool(surface, 'diff_card_versions', { card_id: child.id, from_version: 1, to_version: 'current' })).rejects.toThrow();
    await expect(invokeTestTool(surface, 'diff_card_versions', { card_id: child.id, from_version: 1 })).rejects.toThrow();
    const reversed = await invokeTestTool(surface, 'diff_card_versions', { card_id: child.id, from_version: 2, to_version: 1 });
    expect(reversed).toMatchObject({ success: false, error: 'Invalid card version pivots.' });
  });

  it('slices an oversized diff across exact byte offsets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-diff-slice-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const title = 'Ünïcödé ' + 'ß'.repeat(1200);
    const child = cards.create(childInput('Before'));
    cards.editCard(child.id, { title }, 'planner');
    const surface = surfaceFor(cards);

    let offset = 0;
    const chunks: string[] = [];
    for (;;) {
      const page = await invokeTestTool(surface, 'diff_card_versions', { card_id: child.id, from_version: 1, to_version: 2, byte_offset: offset, response_bytes: 800 });
      const data = page.data as { diff: { content: string; offset_bytes: number; next_offset_bytes: number; total_bytes: number } };
      expect(data.diff.offset_bytes).toBe(offset);
      expect(envelopeBytes(page.data)).toBeLessThanOrEqual(800);
      chunks.push(data.diff.content);
      if (data.diff.next_offset_bytes >= data.diff.total_bytes) break;
      offset = data.diff.next_offset_bytes;
    }
    const parsed = JSON.parse(chunks.join('')) as Array<{ field: string; before: unknown; after: unknown }>;
    expect(parsed.find((entry) => entry.field === 'title')).toMatchObject({ before: 'Before', after: title });
  });

  it('fails a malformed card stream and returns not-found only for an absent numeric row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-tool-missing-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create(childInput('Card'));
    writeFileSync(cardStreamFile(root, child.id), 'complete malformed stream\n');
    const surface = surfaceFor(cards);

    await expect(invokeTestTool(surface, 'list_card_versions', { card_id: child.id })).rejects.toThrow();
    await expect(invokeTool(surface, 'get_card_version', { card_id: child.id, version: 1, section: 'summary' })).rejects.toThrow();
    const fresh = mkdtempSync(join(tmpdir(), 'saivage-card-version-tool-absent-')); roots.push(fresh); initProjectTree(fresh);
    const freshCards = new CardService(fresh);
    const freshChild = freshCards.create(childInput('Card'));
    const freshSurface = surfaceFor(freshCards);
    await expect(invokeTestTool(freshSurface, 'get_card_version', { card_id: freshChild.id, version: 9, section: 'summary' })).resolves.toEqual({ success: false, error: 'Card version not found.', data: { code: 'card_version_not_found', card_id: freshChild.id, version: 9 } });
  });

  it('reads exact record version rows with state-dependent content and a stable locator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-record-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create(childInput('Card'));
    cards.openRecord(child.id, 'status.md');
    cards.editRecord(child.id, 'status.md', 'draft content');
    cards.closeRecord(child.id, 'status.md', 'planner');
    cards.openRecord(child.id, 'status.md');
    cards.editRecord(child.id, 'status.md', 'second draft');
    const surface = surfaceFor(cards);

    const openHead = await invokeTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 5 });
    const openHeadResult = settleToolActionOutcome(openHead.providerOutcome).providerResult as { success: boolean; data: { state: string; content_source: string; content: { content: string }; entry_id: string; version_url: string } };
    expect(openHead.evidence).toMatchObject({ kind: 'canonical_locator' });
    expect((openHead.evidence as { locator: string }).locator).toBe(`${openHeadResult.data.version_url}#entry=${openHeadResult.data.entry_id}`);
    expect(openHeadResult.data.version_url).toBe(`record:///status.md?card=${encodeURIComponent(child.id)}&v=5`);
    expect(openHeadResult.data.state).toBe('open');
    expect(openHeadResult.data.content_source).toBe('draft');
    expect(openHeadResult.data.content.content).toBe('second draft');

    const closed = await invokeTestTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 3 });
    const closedResult = closed as { success: boolean; data: { state: string; content_source: string; content: { content: string } } };
    expect(closedResult.data.state).toBe('closed');
    expect(closedResult.data.content_source).toBe('accepted');
    expect(closedResult.data.content.content).toBe('draft content');

    await expect(invokeTestTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 99 })).resolves.toMatchObject({ success: false, error: 'Record version not found.' });
    await expect(invokeTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 1, source_version: 1 })).rejects.toThrow();
  });

  it('returns the discarded baseline or an empty terminal slice without following accepted source identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-discarded-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create(childInput('Card'));
    cards.openRecord(child.id, 'status.md');
    cards.editRecord(child.id, 'status.md', 'baseline');
    cards.closeRecord(child.id, 'status.md', 'planner');
    cards.openRecord(child.id, 'status.md');
    cards.editRecord(child.id, 'status.md', 'wrong direction draft');
    cards.discardRecord(child.id, 'status.md', 'wrong direction');
    const surface = surfaceFor(cards);

    const streamPath = cardRecordStreamFile(root, child.id, { filename: 'status.md' });
    const rows = readStrictCanonicalGrowingFile(streamPath, authoredRecordVersionArtifactSchema);
    expect(rows).toHaveLength(6);
    const closedRow = rows[2]!;
    const discardedRow = rows[5]!;
    expect(discardedRow.accepted?.source_version).toBe(3);
    expect(discardedRow.entry_id).not.toBe(closedRow.entry_id);

    const discardedWithBaseline = await invokeTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 6 });
    const discardedResult = settleToolActionOutcome(discardedWithBaseline.providerOutcome).providerResult as { success: boolean; data: { version: number; entry_id: string; state: string; content_source: string; content: { content: string }; content_sha256: string | null; total_bytes: number } };
    expect(discardedResult.data).toMatchObject({ version: 6, entry_id: discardedRow.entry_id, state: 'discarded', content_source: 'accepted', content_sha256: closedRow.accepted!.content_sha256 });
    expect(discardedResult.data.content.content).toBe('baseline');
    expect(discardedWithBaseline.evidence).toMatchObject({ kind: 'canonical_locator', locator: `record:///status.md?card=${encodeURIComponent(child.id)}&v=6#entry=${discardedRow.entry_id}`, sha256: closedRow.accepted!.content_sha256 });

    const paged = await invokeTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 6, byte_offset: 4, response_bytes: 512 });
    expect((paged.evidence as { locator: string }).locator).toBe((discardedWithBaseline.evidence as { locator: string }).locator);
    expect((paged.evidence as { sha256: string }).sha256).toBe((discardedWithBaseline.evidence as { sha256: string }).sha256);

    const other = mkdtempSync(join(tmpdir(), 'saivage-card-version-discarded-none-')); roots.push(other); initProjectTree(other);
    const otherCards = new CardService(other);
    const otherChild = otherCards.create(childInput('Card'));
    otherCards.openRecord(otherChild.id, 'status.md');
    otherCards.discardRecord(otherChild.id, 'status.md', 'nothing');
    const noneResult = await invokeTestTool(surfaceFor(otherCards), 'read_record_version', { card_id: otherChild.id, record_name: 'status.md', version: 2 });
    expect(noneResult).toMatchObject({ success: true, data: { state: 'discarded', content_source: 'none', content_sha256: null, total_bytes: 0 } });
    expect((noneResult.data as { content: { content: string } }).content.content).toBe('');
  });

  it('fails a malformed record stream and never probes card authority for card.md rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-record-md-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create(childInput('Card'));
    const surface = surfaceFor(cards);

    const mdPath = cardRecordStreamFile(root, child.id, { filename: 'card.md' });
    expect(mdPath.endsWith('/record-card.jsonl')).toBe(true);
    expect(mdPath).not.toBe(cardStreamFile(root, child.id));
    const reads: string[] = [];
    await expect(invokeTestTool(surface, 'read_record_version', { card_id: child.id, record_name: 'card.md', version: 1 })).resolves.toMatchObject({ success: false, error: 'Record version not found.' });
    writeFileSync(mdPath, 'complete malformed record stream\n');
    await expect(invokeTestTool(surface, 'read_record_version', { card_id: child.id, record_name: 'card.md', version: 1 })).rejects.toThrow();
    expect(reads).toEqual([]);
  });

  it('pins an immutable card version row across pages and sections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-pin-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const tags = Array.from({ length: 900 }, (_, index) => `tag-${index}`);
    const child = cards.create(childInput('Card', tags));
    const surface = surfaceFor(cards);

    const first = await invokeTool(surface, 'get_card_version', { card_id: child.id, version: 1, section: 'tags', response_bytes: 2048 });
    const firstData = (settleToolActionOutcome(first.providerOutcome).providerResult as { data: { artifact_sha256: string; entry_id: string; content: { total: number; returned: number; next: unknown; items: string[] } } }).data;
    expect(first.evidence).toMatchObject({ kind: 'canonical_locator' });
    expect((first.evidence as { locator: string }).locator).toBe(`card:///${child.id}?v=1#entry=${firstData.entry_id}`);
    expect(firstData.content.total).toBe(900);
    expect(firstData.content.returned).toBeLessThan(900);
    expect(firstData.content.items.every((tag) => tag.startsWith('tag-'))).toBe(true);

    const position = firstData.content.next as { item_index: number; item_byte_offset: number };
    const second = await invokeTool(surface, 'get_card_version', { card_id: child.id, version: 1, section: 'tags', response_bytes: 32768, position });
    const secondData = (settleToolActionOutcome(second.providerOutcome).providerResult as { data: { artifact_sha256: string; content: { items: string[] } } }).data;
    expect(secondData.content.items[0]).toBe(`tag-${firstData.content.returned}`);
    expect(secondData.artifact_sha256).toBe(firstData.artifact_sha256);
    expect((second.evidence as { sha256: string }).sha256).toBe((first.evidence as { sha256: string }).sha256);
    expect((second.evidence as { locator: string }).locator).toBe((first.evidence as { locator: string }).locator);

    const summary = await invokeTool(surface, 'get_card_version', { card_id: child.id, version: 1, section: 'summary' });
    expect((summary.evidence as { locator: string }).locator).toBe((first.evidence as { locator: string }).locator);
    expect((summary.evidence as { sha256: string }).sha256).toBe((first.evidence as { sha256: string }).sha256);
  });

  it('reconstructs an oversized immutable collection item from projected canonical JSON hex slices', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-json-slice-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const tag = `ask-secret-tail token=synthetic-token-value ${'🚀 quoted " \\ '.repeat(180)}`;
    const child = cards.create(childInput('Card', [tag]));
    const surface = surfaceFor(cards);
    const expected = canonicalJson(projectDynamicForOutbound(utf8SafePreview(redactTextForOutbound(tag), DISCOVERY_TEXT_PREVIEW_MAX_BYTES)));
    const chunks: Buffer[] = [];
    let position: { item_index: number; item_byte_offset: number } | undefined;

    for (;;) {
      const result = await invokeTestTool(surface, 'get_card_version', {
        card_id: child.id,
        version: 1,
        section: 'tags',
        response_bytes: 700,
        position,
      });
      expect(envelopeBytes(result.data)).toBeLessThanOrEqual(700);
      const content = (result.data as { content: { items: unknown[]; next: { item_index: number; item_byte_offset: number } | null } }).content;
      const slice = content.items[0] as { content_hex: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number; total_bytes: number };
      expect(slice.content_hex).toMatch(/^(?:[0-9a-f]{2})+$/u);
      const decoded = Buffer.from(slice.content_hex, 'hex');
      expect(decoded).toHaveLength(slice.utf8_bytes);
      expect(decoded).toEqual(Buffer.from(expected, 'utf8').subarray(slice.offset_bytes, slice.next_offset_bytes));
      expect(slice.total_bytes).toBe(Buffer.byteLength(expected, 'utf8'));
      chunks.push(decoded);
      if (content.next === null) break;
      position = content.next;
    }

    expect(Buffer.concat(chunks).toString('utf8')).toBe(expected);
    expect(expected).toContain('ask-secret-tail');
    expect(expected).toContain('[REDACTED]');
    expect(expected).not.toContain('synthetic-token-value');
  });
});
