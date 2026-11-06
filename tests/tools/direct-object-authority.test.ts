import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { allowsReachedObject, assertHistoricalObjectAuthority } from '../../src/tools/direct-object-authority.js';
import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { cardNamespace, cardHeadFile } from '../../src/persistence/layout.js';
import type { CapabilityScope } from '../../src/schemas/index.js';
import { createAnalystMutationServices } from '../../src/application/analyst-mutation-services.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'direct-object-authority-')); roots.push(projectRoot);
  initProjectTree(projectRoot);
  const store = new CardService(projectRoot);
  const create = (parent: string, type: string) => store.create({ parent, type, title: 'Target', bootstrap_content: 'Requirements',
    priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
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

it('matches canonical relationships and same-clause unions without cross-pairing scopes and patterns', () => {
  const f = fixture();
  const expected: Record<CapabilityScope, string[]> = {
    self: [f.parent.id], children: [f.child.id], descendants: [f.child.id, f.grandchild.id],
    all: ['project', f.parent.id, f.child.id, f.grandchild.id, f.sibling.id],
  };
  for (const scope of Object.keys(expected) as CapabilityScope[]) {
    const authority = { anchorCardId: f.parent.id, tools: [resolveRuntimeTool('card', 'get_card', [{ kind: 'card', scopes: [scope] }])] };
    for (const id of ['project', f.parent.id, f.child.id, f.grandchild.id, f.sibling.id]) {
      if (expected[scope].includes(id)) expect(() => assertHistoricalObjectAuthority(authority, f.store, 'get_card', { kind: 'card', cardId: id })).not.toThrow();
      else expect(() => assertHistoricalObjectAuthority(authority, f.store, 'get_card', { kind: 'card', cardId: id })).toThrow(/not authorized/);
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
  expect(history).not.toHaveBeenCalled();
  const record = jest.spyOn(f.store, 'readRecordVersion');
  expect(await invokeTestTool(f.bind('read_record_version', ['children'], ['status.md']), 'read_record_version', { card_id: f.child.id, record_name: 'brief.md', version: 1 })).toMatchObject({ success: false });
  expect(record).not.toHaveBeenCalled();
  const orphan = `${f.parent.id}-b`;
  mkdirSync(cardNamespace(f.projectRoot, orphan), { recursive: true });
  writeFileSync(cardHeadFile(f.projectRoot, orphan), 'not canonical JSON');
  expect(await invokeTestTool(f.bind('get_card', ['all']), 'get_card', { id: orphan, section: 'summary' })).toMatchObject({ success: false });
  expect(await invokeTestTool(f.bind('get_card', ['all']), 'get_card', { id: f.child.id, section: 'summary', anchorCardId: f.child.id })).toMatchObject({ success: false });
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
