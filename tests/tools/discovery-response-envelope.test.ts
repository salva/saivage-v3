import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { bindToolProvider } from '../../src/tools/invocation.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';
import { cardVersionToolBinders } from '../../src/tools/card-version-provider.js';
import { analystWorkspaceToolBinders } from '../../src/tools/workspace-provider.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { DISCOVERY_RESPONSE_MAX_BYTES, DISCOVERY_RESPONSE_MIN_BYTES } from '../../src/contracts/builtin-tool-inputs.js';
import {
  emptyToolInputSchema,
  listProcessesInputSchema,
  readAgentSessionInputSchema,
  readControlActionsInputSchema,
  readRuntimeErrorsInputSchema,
  readRuntimeEventsInputSchema,
  readWorkspaceInputSchema,
} from '../../src/contracts/builtin-tool-inputs.js';
import { mcpToolBinders } from '../../src/tools/mcp-provider.js';
import { llmToolDefinition } from '../../src/tools/invocation.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

const envelopeBytes = (data: unknown): number => Buffer.byteLength(canonicalJson({ success: true, data }), 'utf8');
const UNICODE = 'Ünïcödé-ßtrïng-🚀-';

function analystSurface(cards: CardService, projectRoot: string, cardTypeVocabulary: readonly string[] = ['project', 'goal', 'code']) {
  const context = { cardTypeVocabulary, store: cards, projectRoot, cardId: 'project', sessionId: 'agent:analyst:global', actor: 'analyst', runtime: { notifyCard: () => ({ ok: true, notificationId: 'n' }) } } as unknown as ToolContext;
  return buildInvocationSurfaceFixture('analyst', [
    bindToolProvider('card-inspection', cardInspectionToolBinders, { store: cards, cardTypeVocabulary }),
    bindToolProvider('card-version', cardVersionToolBinders, { store: cards }),
    ...analystWorkspaceToolBinders.map((binder) => bindToolProvider('workspace', [binder], context)).slice(0, 1),
  ]);
}

describe('cut-over discovery surfaces exact envelope contract', () => {
  it('never exceeds the envelope for huge Unicode titles, tags, notifications, versions, diffs, and wide collections', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-discovery-envelope-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const wide = 80;
    for (let index = 0; index < wide; index += 1) {
      const child = cards.create({ type: 'goal', parent: 'project', title: `${UNICODE}title-${index}-${'ß'.repeat(40)}`, bootstrap_content: 'brief', tags: [`${UNICODE}tag-${index}`], priority: index, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      if (index % 5 === 0) cards.enqueueNotification(child.id, { id: `n-${index}`, content: `${UNICODE}notification ${'ñ'.repeat(200)}`, created_at: '2026-08-18T00:00:00.000Z' });
      if (index % 7 === 0) cards.editCard(child.id, { title: `${UNICODE}edited-${index}-${'ü'.repeat(60)}` }, 'analyst');
    }
    const surface = analystSurface(cards, projectRoot);

    for (const tool of ['list_cards'] as const) {
      let position: { item_index: number; item_byte_offset: number } | undefined;
      let seen = 0;
      for (;;) {
        const page = await invokeTestTool(surface, tool, { position, response_bytes: 2048 });
        expect(envelopeBytes(page.data)).toBeLessThanOrEqual(2048);
        const cardsPage = (page.data as { cards: { returned: number; next: { item_index: number; item_byte_offset: number } | null } }).cards;
        seen += cardsPage.returned;
        position = cardsPage.next ?? undefined;
        if (!position) break;
      }
      expect(seen).toBe(wide + 1);
    }

    for (const args of [
      { id: 'project', section: 'summary' } as const,
      { id: 'project', section: 'tags' } as const,
      { id: 'project', section: 'children', response_bytes: 1024 } as const,
      { id: cards.listChildren('project').find((id) => id !== undefined && cards.read(id)!.pending_notifications.length > 0)!, section: 'notifications', response_bytes: 1024 } as const,
      { id: 'project', section: 'records' } as const,
    ]) {
      const result = await invokeTestTool(surface, 'get_card', args);
      expect(envelopeBytes(result.data)).toBeLessThanOrEqual(args.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES);
    }

    const tree = await invokeTestTool(surface, 'get_tree', { rootId: 'project', depth: 2, response_bytes: 1500 });
    expect(envelopeBytes(tree.data)).toBeLessThanOrEqual(1500);

    const firstChild = cards.listChildren('project')[0]!;
    const versions = await invokeTestTool(surface, 'list_card_versions', { card_id: firstChild, response_bytes: 900 });
    expect(envelopeBytes(versions.data)).toBeLessThanOrEqual(900);
    const versionPage = (versions.data as { versions: { total: number } }).versions;
    expect(versionPage.total).toBeGreaterThan(1);

    const versionSlice = await invokeTestTool(surface, 'get_card_version', { card_id: firstChild, version: 2, section: 'summary', response_bytes: 800 });
    expect(envelopeBytes(versionSlice.data)).toBeLessThanOrEqual(800);

    const diff = await invokeTestTool(surface, 'diff_card_versions', { card_id: firstChild, from_version: 1, to_version: 2, response_bytes: 700 });
    expect(envelopeBytes(diff.data)).toBeLessThanOrEqual(700);
  }, 180_000);

  it('slices record document reads and record versions on UTF-8 boundaries', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-discovery-record-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'goal', parent: 'project', title: 'Record host', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.openRecord(child.id, 'status.md', null);
    const content = Array.from({ length: 3000 }, (_, index) => `${UNICODE} line ${index}`).join('\n');
    cards.editRecord(child.id, 'status.md', 1, content);
    const surface = analystSurface(cards, projectRoot);

    const recordRead = await invokeTestTool(surface, 'read', { path: `record:///status.md?card=${encodeURIComponent(child.id)}`, response_bytes: 900, position: { kind: 'text', byte_offset: 0 } });
    expect(envelopeBytes(recordRead.data)).toBeLessThanOrEqual(900);
    const slice = (recordRead.data as { content: { content: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number } }).content;
    expect(slice.offset_bytes).toBe(0);
    expect(slice.next_offset_bytes).toBe(slice.utf8_bytes);
    expect(content.startsWith(slice.content)).toBe(true);

    const versioned = await invokeTestTool(surface, 'read', { path: `record:///status.md?card=${encodeURIComponent(child.id)}&v=2`, response_bytes: 600, position: { kind: 'text', byte_offset: 10 } });
    expect(envelopeBytes(versioned.data)).toBeLessThanOrEqual(600);
    const versionedSlice = (versioned.data as { content: { offset_bytes: number; content: string; utf8_bytes: number } }).content;
    expect(versionedSlice.offset_bytes).toBe(10);
    expect(content.startsWith(versionedSlice.content)).toBe(false);
    expect(Buffer.from(content, 'utf8').subarray(10, 10 + (versionedSlice as { utf8_bytes: number }).utf8_bytes).toString('utf8')).toBe(versionedSlice.content);

    const directory = await invokeTestTool(surface, 'read', { path: `record:///${child.id}`, response_bytes: DISCOVERY_RESPONSE_MIN_BYTES });
    expect(envelopeBytes(directory.data)).toBeLessThanOrEqual(DISCOVERY_RESPONSE_MIN_BYTES);
    expect((directory.data as { records: { items: unknown[] } }).records.items.length).toBeGreaterThan(0);
  });

  it('measures outbound redaction before paging work file content', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-discovery-work-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    mkdirSync(join(projectRoot, '.saivage/work/tmp/stash'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage/work/tmp/stash/output.log'), Array.from({ length: 3000 }, () => 'Authorization: Bearer secret-token-value').join('\n'), 'utf8');
    const surface = analystSurface(cards, projectRoot);

    const result = await invokeTestTool(surface, 'read', { path: 'work:///tmp/stash/output.log', response_bytes: 2048 });
    expect(envelopeBytes(result.data)).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(result.data)).not.toContain('secret-token-value');
    expect(JSON.stringify(result.data)).toContain('[REDACTED]');
  });

  it('rejects caps below the documented minimum as input validation', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-discovery-minimum-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const surface = analystSurface(cards, projectRoot);

    await expect(invokeTestTool(surface, 'list_cards', { response_bytes: DISCOVERY_RESPONSE_MIN_BYTES - 1 })).rejects.toThrow(/response_bytes/u);
    await expect(invokeTestTool(surface, 'list_cards', { response_bytes: DISCOVERY_RESPONSE_MAX_BYTES + 1 })).rejects.toThrow(/response_bytes/u);
  });

  it('observes fresh state between pages without a cursor registry', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-discovery-fresh-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    for (let index = 0; index < 20; index += 1) cards.create({ type: 'goal', parent: 'project', title: `Card ${index}`, bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const surface = analystSurface(cards, projectRoot);

    const first = await invokeTestTool(surface, 'list_cards', { response_bytes: DISCOVERY_RESPONSE_MAX_BYTES });
    const firstObservation = (first.data as { observation_sha256: string; cards: { next: unknown } }).observation_sha256;
    const firstNext = (first.data as { cards: { next: unknown } }).cards.next;
    expect(firstNext).toBeNull();

    cards.create({ type: 'goal', parent: 'project', title: 'Late card', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const second = await invokeTestTool(surface, 'list_cards', { response_bytes: DISCOVERY_RESPONSE_MAX_BYTES });
    const secondData = second.data as { observation_sha256: string; cards: { total: number; position: { item_index: number; item_byte_offset: number } } };
    expect(secondData.cards.total).toBe(22);
    expect(secondData.observation_sha256).not.toBe(firstObservation);
    expect(secondData.cards.position).toEqual({ item_index: 0, item_byte_offset: 0 });
    expect(JSON.stringify(secondData)).not.toMatch(/cursor|token/u);
  });

  it('rejects removed contract inputs across the cut-over surfaces', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-discovery-contracts-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'goal', parent: 'project', title: 'Card', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const surface = analystSurface(cards, projectRoot);

    await expect(invokeTestTool(surface, 'read', { path: 'README.md', offset: 0 } as never)).rejects.toThrow();
    await expect(invokeTestTool(surface, 'read', { path: 'README.md', limit: 10 } as never)).rejects.toThrow();
    await expect(invokeTestTool(surface, 'get_card', { id: child.id, section: 'summary', version: 2 } as never)).rejects.toThrow();
    await expect(invokeTestTool(surface, 'get_card', { id: child.id, section: 'summary', record_content: true } as never)).rejects.toThrow();
    await expect(invokeTestTool(surface, 'diff_card_versions', { card_id: child.id, from_version: 1, to_version: 'current' } as never)).rejects.toThrow();
    await expect(invokeTestTool(surface, 'diff_card_versions', { card_id: child.id, from_version: 1 } as never)).rejects.toThrow();
    await expect(invokeTestTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md', source_version: 1 } as never)).rejects.toThrow();
    await expect(invokeTestTool(surface, 'read_record_version', { card_id: child.id, record_name: 'status.md' } as never)).rejects.toThrow();
    await expect(invokeTestTool(surface, 'get_card_version', { card_id: child.id, version: 1 } as never)).rejects.toThrow();
    await expect(invokeTestTool(surface, 'get_tree', {} as never)).rejects.toThrow();
  });

  it('keeps diagnostic, session, process, control-action, and MCP surfaces outside the paging API', () => {
    for (const schema of [readRuntimeEventsInputSchema, readRuntimeErrorsInputSchema, readControlActionsInputSchema, listProcessesInputSchema, readAgentSessionInputSchema, emptyToolInputSchema]) {
      const shape = JSON.stringify(schema.safeParse({ response_bytes: 512, position: { item_index: 0, item_byte_offset: 0 } }));
      expect(shape).toContain('false');
    }
    const readShape = readWorkspaceInputSchema.safeParse({ path: 'a', offset: 0, limit: 1 });
    expect(readShape.success).toBe(false);
    for (const binder of mcpToolBinders) {
      const wire = JSON.stringify(llmToolDefinition(binder.bind({ mcpToolInvocation: {} as never })));
      expect(wire).not.toContain('response_bytes');
      expect(wire).not.toContain('item_byte_offset');
    }
  });
});
