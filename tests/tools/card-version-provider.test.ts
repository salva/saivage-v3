import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cardVersionToolBinders } from '../../src/tools/card-version-provider.js';
import { bindToolProvider, invokeTool } from '../../src/tools/invocation.js';
import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { cardVersionIndexFile, cardVersionFile } from '../../src/persistence/layout.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { canonicalJson } from '../../src/schemas/index.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const envelopeBytes = (data: unknown): number => Buffer.byteLength(canonicalJson({ success: true, data }), 'utf8');

function surfaceFor(cards: CardService) {
  return buildInvocationSurfaceFixture('planner', [bindToolProvider('card-version', cardVersionToolBinders, { store: cards })]);
}

describe('card version provider', () => {
  it('lists index metadata paged by byte budget and reads and diffs exact resulting versions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-tool-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Before', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.editCard(child.id, { title: 'After' }, 'planner');
    const surface = surfaceFor(cards);

    const listed = await invokeTestTool(surface, 'list_card_versions', { card_id: child.id });
    const listData = listed.data as { observation_sha256: string; versions: { total: number; returned: number; items: Array<{ version: number; entry_id: string; change: unknown }> } };
    expect(listData.versions.total).toBe(2);
    expect(listData.versions.items.map((entry) => entry.version)).toEqual([1, 2]);
    expect(listData.observation_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(envelopeBytes(listed.data)).toBeLessThanOrEqual(32768);

    const version = await invokeTool(surface, 'get_card_version', { card_id: child.id, version: 2, section: 'summary' });
    expect(version.evidence).toMatchObject({ kind: 'canonical_locator', locator: `card:///${child.id}?v=2#entry=${(listData.versions.items[1]!.entry_id)}`, sha256: expect.any(String) });
    expect(version.providerResult).toMatchObject({ success: true, data: { card_id: child.id, version: 2, section: 'summary', card: { title: 'After' } } });
    expect(envelopeBytes((version.providerResult as { data: unknown }).data)).toBeLessThanOrEqual(32768);

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
    const child = cards.create({ type: 'code', parent: 'project', title: 'Card', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
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
    const child = cards.create({ type: 'code', parent: 'project', title: 'Before', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
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

  it('keeps list metadata available when selected historical content is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-tool-missing-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Card', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const index = JSON.parse(readFileSync(cardVersionIndexFile(root, child.id), 'utf8') as string) as { versions: Array<{ filename: string }> };
    rmSync(cardVersionFile(root, child.id, index.versions[0]!.filename));
    const surface = surfaceFor(cards);

    await expect(invokeTestTool(surface, 'list_card_versions', { card_id: child.id })).resolves.toMatchObject({ success: true, data: { versions: { total: 1 } } });
    await expect(invokeTestTool(surface, 'get_card_version', { card_id: child.id, version: 1, section: 'summary' })).resolves.toEqual({ success: false, error: 'Historical card version content unavailable.', data: { code: 'historical_version_content_unavailable', resource: 'card', owner_id: child.id, version: 1, reason: 'missing' } });
  });

  it('reads exact record artifact versions with state-dependent content and a stable locator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-record-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Card', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.openRecord(child.id, 'status.md', null);
    cards.editRecord(child.id, 'status.md', 1, 'draft content');
    cards.closeRecord(child.id, 'status.md', 2, 'planner');
    cards.openRecord(child.id, 'status.md', 3);
    cards.editRecord(child.id, 'status.md', 4, 'second draft');
    const surface = surfaceFor(cards);

    const openHead = await invokeTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 5 });
    const openHeadResult = openHead.providerResult as { success: boolean; data: { state: string; content_source: string; content: { content: string }; entry_id: string; version_url: string } };
    expect(openHead.evidence).toMatchObject({ kind: 'canonical_locator' });
    expect((openHead.evidence as { locator: string }).locator).toBe(`${openHeadResult.data.version_url}#entry=${openHeadResult.data.entry_id}`);
    expect(openHeadResult.data.state).toBe('open');
    expect(openHeadResult.data.content_source).toBe('draft');
    expect(openHeadResult.data.content.content).toBe('second draft');

    const closed = await invokeTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 3 });
    const closedResult = closed.providerResult as { success: boolean; data: { state: string; content_source: string; content: { content: string } } };
    expect(closedResult.data.state).toBe('closed');
    expect(closedResult.data.content_source).toBe('accepted');
    expect(closedResult.data.content.content).toBe('draft content');

    await expect(invokeTestTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 99 })).resolves.toMatchObject({ success: false, error: 'Record version not found.' });
    await expect(invokeTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 1, source_version: 1 })).rejects.toThrow();
  });

  it('returns the discarded baseline or an empty terminal slice without following accepted source identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-discarded-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Card', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.openRecord(child.id, 'status.md', null);
    cards.editRecord(child.id, 'status.md', 1, 'baseline');
    cards.closeRecord(child.id, 'status.md', 2, 'planner');
    cards.openRecord(child.id, 'status.md', 3);
    cards.discardRecord(child.id, 'status.md', 4, 'wrong direction');
    const surface = surfaceFor(cards);

    const discardedWithBaseline = await invokeTestTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', version: 5 });
    expect(discardedWithBaseline).toMatchObject({ success: true, data: { version: 5, state: 'discarded', content_source: 'accepted' } });
    const baseline = discardedWithBaseline.data as { content: { content: string }; content_sha256: string | null; total_bytes: number };
    expect(baseline.content.content).toBe('baseline');

    const other = mkdtempSync(join(tmpdir(), 'saivage-card-version-discarded-none-')); roots.push(other); initProjectTree(other);
    const otherCards = new CardService(other);
    const otherChild = otherCards.create({ type: 'code', parent: 'project', title: 'Card', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    otherCards.openRecord(otherChild.id, 'status.md', null);
    otherCards.discardRecord(otherChild.id, 'status.md', 1, 'nothing');
    const noneResult = await invokeTestTool(surfaceFor(otherCards), 'read_record_version', { card_id: otherChild.id, record_name: 'status.md', version: 2 });
    expect(noneResult).toMatchObject({ success: true, data: { state: 'discarded', content_source: 'none', content_sha256: null, total_bytes: 0 } });
    expect((noneResult.data as { content: { content: string } }).content.content).toBe('');
  });

  it('pins an immutable card version across pages and sections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-pin-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const tags = Array.from({ length: 900 }, (_, index) => `tag-${index}`);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Card', bootstrap_content: 'Brief', tags, priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const surface = surfaceFor(cards);

    const first = await invokeTool(surface, 'get_card_version', { card_id: child.id, version: 1, section: 'tags', response_bytes: 2048 });
    const firstData = (first.providerResult as { data: { artifact_sha256: string; content: { total: number; returned: number; next: unknown; items: string[] } } }).data;
    expect(first.evidence).toMatchObject({ kind: 'canonical_locator' });
    expect(firstData.content.total).toBe(900);
    expect(firstData.content.returned).toBeLessThan(900);
    expect(firstData.content.items.every((tag) => tag.startsWith('tag-'))).toBe(true);

    const position = firstData.content.next as { item_index: number; item_byte_offset: number };
    const second = await invokeTool(surface, 'get_card_version', { card_id: child.id, version: 1, section: 'tags', response_bytes: 32768, position });
    const secondData = (second.providerResult as { data: { artifact_sha256: string; content: { items: string[] } } }).data;
    expect(secondData.content.items[0]).toBe(`tag-${firstData.content.returned}`);
    expect(secondData.artifact_sha256).toBe(firstData.artifact_sha256);
    expect((second.evidence as { sha256: string }).sha256).toBe((first.evidence as { sha256: string }).sha256);
  });
});
