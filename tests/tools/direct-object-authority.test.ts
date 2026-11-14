import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { allowsReachedObject } from '../../src/tools/direct-object-authority.js';
import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { cardNamespace, cardHeadFile, cardHistoryFile, cardRecordHeadFile } from '../../src/persistence/layout.js';
import type { CapabilityScope } from '../../src/schemas/index.js';
import { createAnalystMutationServices } from '../../src/application/analyst-mutation-services.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'direct-object-authority-')); roots.push(projectRoot);
  initProjectTree(projectRoot);
  const store = new CardService(projectRoot);
  const create = (parent: string, type: string) => store.create({ parent, type, title: 'Target', bootstrap_content: 'Requirements',
    created_by: 'analyst', depends_on: [] });
  const parent = create('project', 'goal');
  const child = create(parent.id, 'goal');
  const grandchild = create(child.id, 'code');
  const sibling = create('project', 'code');
  const activateChild = jest.fn(async () => { throw new Error('Unexpected activation'); });
  const bind = (name: string, scopes: CapabilityScope[], patterns?: string[]) => {
    const tool = resolveRuntimeTool('card', name, patterns
      ? [{ kind: 'record', scopes, patterns }] : [{ kind: 'card', scopes }]);
    return new BoundAgentToolSet([tool]).bind({ scope: 'card', agentName: 'planner', projectRoot, store, cardId: parent.id,
      sessionId: `agent:planner:${parent.id}`, childCreationTypes: new Set(['goal', 'code']), childActivationTypes: new Set(['goal', 'code']),
      cardTypeVocabulary: store.workflows.cardTypeVocabulary, parentControl: { activateChild, cancelChild: async () => { throw new Error('Unexpected cancellation'); }, reopenChild: () => { throw new Error('Unexpected reopen'); } },
      recordMutations: UNUSED_CARD_RECORD_MUTATIONS,
      notifyCard: () => { throw new Error('Unexpected notification'); }, processRunner: {} as never, mcpToolInvocation: {} as never });
  };
  return { projectRoot, store, parent, child, grandchild, sibling, bind, activateChild };
}

it('matches bound history relationships and same-clause unions without cross-pairing scopes and patterns', async () => {
  const f = fixture();
  const expected: Record<CapabilityScope, string[]> = {
    self: [f.parent.id], children: [f.child.id], descendants: [f.child.id, f.grandchild.id],
    all: ['project', f.parent.id, f.child.id, f.grandchild.id, f.sibling.id],
  };
  for (const scope of Object.keys(expected) as CapabilityScope[]) {
    for (const id of ['project', f.parent.id, f.child.id, f.grandchild.id, f.sibling.id]) {
      const result = await invokeTestTool(f.bind('list_card_versions', [scope]), 'list_card_versions', { card_id: id });
      if (expected[scope].includes(id)) expect(result).toMatchObject({ success: true });
      else expect(result).toMatchObject({ success: false, error: expect.stringContaining('not authorized') });
      const record = await invokeTestTool(f.bind('read_record_version', [scope], ['brief.md']), 'read_record_version', { card_id: id, record_name: 'brief.md', version: 1 });
      if (expected[scope].includes(id)) expect(record).toMatchObject({ success: true });
      else expect(record).toMatchObject({ success: false, error: expect.stringContaining('not authorized') });
    }
  }
  const authority = { anchorCardId: f.parent.id, tools: [resolveRuntimeTool('card', 'write', [
    { kind: 'record', scopes: ['self'], patterns: ['status.md'] },
    { kind: 'record', scopes: ['children'], patterns: ['brief.md'] },
  ])] };
  expect(allowsReachedObject(authority, 'write', { kind: 'record', cardId: f.parent.id, name: 'brief.md' })).toBe(false);
  expect(allowsReachedObject(authority, 'write', { kind: 'record', cardId: f.child.id, name: 'status.md' })).toBe(false);
  expect(allowsReachedObject(authority, 'write', { kind: 'record', cardId: f.child.id, name: 'brief.md' })).toBe(true);
  expect(allowsReachedObject(authority, 'edit', { kind: 'record', cardId: f.child.id, name: 'brief.md' })).toBe(false);
});

it('filters actual collection/related rows before totals, cursors and projection', async () => {
  const f = fixture();
  expect(await invokeTestTool(f.bind('list_cards', ['children']), 'list_cards', {}))
    .toMatchObject({ success: true, data: { cards: { total: 1, returned: 1, items: [{ id: f.child.id }] } } });
  expect(await invokeTestTool(f.bind('get_tree', ['self', 'children']), 'get_tree', { rootId: f.parent.id, depth: 12 }))
    .toMatchObject({ success: true, data: { nodes: { total: 2, items: [{ id: f.parent.id }, { id: f.child.id }] } } });
  expect(await invokeTestTool(f.bind('get_card', ['self']), 'get_card', { id: f.parent.id, section: 'children' }))
    .toMatchObject({ success: true, data: { content: { total: 0, items: [] } } });
  const metadata = jest.spyOn(f.store, 'listDeclaredRecordMetadata');
  expect(await invokeTestTool(f.bind('get_card', ['self']), 'get_card', { id: f.child.id, section: 'records' })).toMatchObject({ success: false });
  expect(metadata).not.toHaveBeenCalled();
});

it('denies history/record bodies and unlinked exact namespaces without accepting a model anchor', async () => {
  const f = fixture();
  const history = jest.spyOn(f.store, 'readCardVersion');
  expect(await invokeTestTool(f.bind('get_card_version', ['children']), 'get_card_version', { card_id: f.sibling.id, version: 1, section: 'summary' })).toMatchObject({ success: false });
  expect(history).toHaveBeenCalledTimes(1);
  const record = jest.spyOn(f.store, 'readRecordVersion');
  expect(await invokeTestTool(f.bind('read_record_version', ['children'], ['status.md']), 'read_record_version', { card_id: f.child.id, record_name: 'brief.md', version: 1 })).toMatchObject({ success: false });
  expect(record).toHaveBeenCalledTimes(1);
  const orphan = `${f.parent.id}-b`;
  mkdirSync(cardNamespace(f.projectRoot, orphan), { recursive: true });
  writeFileSync(cardHeadFile(f.projectRoot, orphan), 'not canonical JSON');
  expect(await invokeTestTool(f.bind('get_card', ['all']), 'get_card', { id: orphan, section: 'summary' })).toMatchObject({ success: false });
  expect(await invokeTestTool(f.bind('get_card', ['all']), 'get_card', { id: f.child.id, section: 'summary', anchorCardId: f.child.id })).toMatchObject({ success: false });
});

it('reaches once per bound history operation and checks before protected predecessors, including reversed pivots', async () => {
  const f = fixture();
  const first = f.store.readCardVersion(f.child.id, 1);
  if (first.kind !== 'found') throw new Error('Missing fixture artifact');
  const protectedPath = cardHistoryFile(f.projectRoot, f.child.id, first.value.entry_id);
  f.store.editCard(f.child.id, { title: 'new current' });
  writeFileSync(protectedPath, '{broken protected history');
  const reads: string[] = [];
  const list = f.store.listCardVersions.bind(f.store);
  const read = f.store.readCardVersion.bind(f.store);
  const diff = f.store.diffCardVersions.bind(f.store);
  jest.spyOn(f.store, 'listCardVersions').mockImplementation((id, _io, check) => list(id, { onRead: p => reads.push(p) }, check));
  jest.spyOn(f.store, 'readCardVersion').mockImplementation((id, v, _io, check) => read(id, v, { onRead: p => reads.push(p) }, check));
  jest.spyOn(f.store, 'diffCardVersions').mockImplementation((id, pivots, _io, check) => diff(id, pivots, { onRead: p => reads.push(p) }, check));
  const cases = [
    ['list_card_versions', { card_id: f.child.id }],
    ['get_card_version', { card_id: f.child.id, version: 1, section: 'summary' }],
    ['diff_card_versions', { card_id: f.child.id, from_version: 1, to_version: 2 }],
    ['diff_card_versions', { card_id: f.child.id, from_version: 2, to_version: 1 }],
  ] as const;
  for (const [tool, args] of cases) {
    reads.length = 0;
    expect(await invokeTestTool(f.bind(tool, ['self']), tool, args)).toMatchObject({ success: false, error: expect.stringContaining('not authorized') });
    for (const id of ['project', f.parent.id, f.child.id]) expect(reads.filter(p => p === cardHeadFile(f.projectRoot, id))).toHaveLength(1);
    expect(reads).not.toContain(protectedPath);
  }
  reads.length = 0;
  expect(await invokeTestTool(f.bind('diff_card_versions', ['children']), 'diff_card_versions', cases[3][1])).toMatchObject({ success: false, data: { code: 'invalid_card_version_pivots' } });
  expect(reads).not.toContain(protectedPath);
  expect(reads.filter(p => p === cardHeadFile(f.projectRoot, f.child.id))).toHaveLength(1);
  for (const [tool, args] of cases.slice(0, 3)) {
    reads.length = 0;
    await expect(invokeTestTool(f.bind(tool, ['children']), tool, args)).rejects.toThrow();
    expect(reads).toContain(protectedPath);
  }
});

it('preserves generic accepted record locators and denies before malformed protected record heads', async () => {
  const f = fixture();
  f.store.acceptRecord(f.child.id, 'notes.md', 'generic accepted content', { kind: 'agent', agent: 'planner' });
  expect(await invokeTestTool(f.bind('read_record_version', ['children'], ['notes.md']), 'read_record_version', { card_id: f.child.id, record_name: 'notes.md', version: 1 }))
    .toMatchObject({ success: true, data: { version: 1, version_url: `record:///notes.md?card=${f.child.id}&v=1`, content: { content: 'generic accepted content' } } });
  const protectedPath = cardRecordHeadFile(f.projectRoot, f.child.id, { filename: 'notes.md' });
  writeFileSync(protectedPath, '{broken protected record');
  const reads: string[] = [];
  const original = f.store.readRecordVersion.bind(f.store);
  jest.spyOn(f.store, 'readRecordVersion').mockImplementation((id, name, v, _io, check) => original(id, name, v, { onRead: p => reads.push(p) }, check));
  expect(await invokeTestTool(f.bind('read_record_version', ['children'], ['status.md']), 'read_record_version', { card_id: f.child.id, record_name: 'notes.md', version: 1 }))
    .toMatchObject({ success: false, error: expect.stringContaining('not authorized') });
  expect(reads).not.toContain(protectedPath);
  expect(reads.filter(p => p === cardHeadFile(f.projectRoot, f.child.id))).toHaveLength(1);
  await expect(invokeTestTool(f.bind('read_record_version', ['children'], ['notes.md']), 'read_record_version', { card_id: f.child.id, record_name: 'notes.md', version: 1 })).rejects.toThrow();
  expect(reads).toContain(protectedPath);
});

it('distinguishes linked tombstones, hidden descendants and unlinked absence without orphan reads', async () => {
  const f = fixture();
  f.store.deleteSubtrees([f.child.id], () => true, 'analyst');
  const tool = 'list_card_versions';
  expect(await invokeTestTool(f.bind(tool, ['children']), tool, { card_id: f.child.id })).toMatchObject({ success: true });
  expect(await invokeTestTool(f.bind(tool, ['self']), tool, { card_id: f.child.id })).toMatchObject({ success: false, error: expect.stringContaining('not authorized') });
  const record = (scopes: CapabilityScope[], id: string) => invokeTestTool(f.bind('read_record_version', scopes, ['brief.md']), 'read_record_version', { card_id: id, record_name: 'brief.md', version: 1 });
  expect(await record(['self'], f.child.id)).toMatchObject({ success: false, error: expect.stringContaining('not authorized') });
  expect(await record(['children'], f.child.id)).toMatchObject({ success: false, data: { code: 'record_version_not_found' } });
  writeFileSync(cardHeadFile(f.projectRoot, f.grandchild.id), '{hidden invalid head');
  const orphan = `${f.parent.id}-z`;
  mkdirSync(cardNamespace(f.projectRoot, orphan), { recursive: true });
  writeFileSync(cardHeadFile(f.projectRoot, orphan), '{orphan invalid head');
  for (const id of [f.grandchild.id, orphan, 'card-z']) {
    expect(await invokeTestTool(f.bind(tool, ['all']), tool, { card_id: id })).toMatchObject({ success: false, error: `Card '${id}' not found.` });
    expect(await record(['all'], id)).toMatchObject({ success: false, error: `Card '${id}' not found.` });
  }
});

it.each(['head', 'current', 'missing-current'] as const)('strictly rejects broken %s admission before a denied grant', async fault => {
  const f = fixture();
  const selected = JSON.parse(readFileSync(cardHeadFile(f.projectRoot, f.child.id), 'utf8'));
  const path = fault === 'head' ? cardHeadFile(f.projectRoot, f.child.id) : cardHistoryFile(f.projectRoot, f.child.id, selected.ordinary.entry_id);
  if (fault === 'missing-current') unlinkSync(path); else writeFileSync(path, '{invalid admission');
  await expect(invokeTestTool(f.bind('list_card_versions', ['self']), 'list_card_versions', { card_id: f.child.id })).rejects.toThrow(fault === 'missing-current' ? /ENOENT/ : /JSON/);
});

it('denies Planner parent/metadata effects and activation before namespace claim, edit, reorder or lease delegation', async () => {
  const f = fixture();
  const create = jest.spyOn(f.store, 'create');
  const edit = jest.spyOn(f.store, 'editCard');
  const reorder = jest.spyOn(f.store, 'reorderChildren');
  expect(await invokeTestTool(f.bind('create_card', ['children']), 'create_card', { type: 'code', title: 'Denied', bootstrap_content: 'Requirements' })).toMatchObject({ success: false });
  expect(await invokeTestTool(f.bind('edit_card', ['self']), 'edit_card', { card_id: f.child.id, title: 'Denied' })).toMatchObject({ success: false });
  expect(await invokeTestTool(f.bind('reorder_child', ['children']), 'reorder_child', { orderedChildIds: [f.child.id] })).toMatchObject({ success: false });
  expect(await invokeTestTool(f.bind('activate_card', ['self']), 'activate_card', { card_id: f.child.id, instructions: 'Denied' })).toMatchObject({ success: false });
  expect(create).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled(); expect(reorder).not.toHaveBeenCalled(); expect(f.activateChild).not.toHaveBeenCalled();
  expect(await invokeTestTool(f.bind('create_card', ['self']), 'create_card', { type: 'code', title: 'Granted', bootstrap_content: 'Requirements' })).toMatchObject({ success: true });
});

it('checks Analyst compiled capabilities at card effects, not only the invocation wrapper', async () => {
  const f = fixture();
  const cancel = jest.fn(async () => { throw new Error('Unexpected cancellation'); });
  const services = createAnalystMutationServices({ author: { kind: 'agent', agent: 'analyst' },
    authority: { anchorCardId: null, tools: [] }, store: f.store, configAuthority: {} as never,
    notifyCard: () => { throw new Error('Unexpected notification'); },
    submitNotification: async () => { throw new Error('Unexpected notification'); }, cancelCard: cancel });
  const create = jest.spyOn(f.store, 'create'); const deletion = jest.spyOn(f.store, 'deleteSubtrees'); const reorder = jest.spyOn(f.store, 'reorderChildren');
  expect(services.cards.create({ parent: f.parent.id, type: 'code', title: 'Denied', bootstrap_content: 'Requirements' })).toEqual({ kind: 'denied', reason: 'direct_object_not_authorized' });
  expect(services.cards.delete([f.child.id, f.sibling.id])).toEqual({ kind: 'denied', reason: 'direct_object_not_authorized' });
  expect(services.cards.reorder(f.parent.id, [f.child.id])).toEqual({ kind: 'denied', reason: 'direct_object_not_authorized' });
  expect(services.cards.reopen(f.child.id)).toEqual({ kind: 'denied', reason: 'direct_object_not_authorized' });
  expect(await services.cards.cancel(f.child.id)).toEqual({ kind: 'denied', reason: 'direct_object_not_authorized' });
  expect(create).not.toHaveBeenCalled(); expect(deletion).not.toHaveBeenCalled(); expect(reorder).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});
import { UNUSED_CARD_RECORD_MUTATIONS } from '../helpers/capability-grants.js';
