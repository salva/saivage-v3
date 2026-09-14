import { describe, expect, it } from '@jest/globals';

import { getAnalystControlToolBinders } from '../../src/tools/analyst-tool-registry.js';
import { BoundAgentToolSet } from '../../src/tools/runtime-tool-catalog.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { TEST_WORKFLOWS } from '../helpers/canonical-project.js';

const cardTypeVocabulary = ['project','goal','architecture','code','test','doc','data','research','ops'];

function bindConfiguredAnalystSurface() {
  return new BoundAgentToolSet(TEST_WORKFLOWS.analyst.tools).bind({
    scope: 'global',
    agentName: 'analyst',
    projectRoot: '/',
    store: {} as never,
    processRunner: {} as never,
    processScope: {},
    processOwnerId: 'agent:analyst:global',
    mcpToolInvocation: {} as never,
    analystToolContext: { restartCapability: { available: false }, actor: 'analyst', surface: 'web-chat', cardTypeVocabulary, runtime: { notifyCard: () => ({ ok: false, reason: 'missing_card', cardId: 'project' }), submitNotification: async () => ({ queued: false, reason: 'missing_card', cardId: 'project' }) }, captureExecutingLlmSnapshots: () => new Map() } as never,
    observationToolContext: { projectRoot:'/',store:{} as never,processRunner:{} as never,eventQueries:{} as never,runtime:{} as never,queueNotification:async()=>{throw new Error('unused notification');},captureExecutingLlmSnapshots:()=>new Map() },
    cardTypeVocabulary,
  } as never);
}

describe('registered Analyst card mutation catalog', () => {
  const context = { cardTypeVocabulary } as never;
  it('lazily installs one stable immutable binder list after circular module initialization',()=>{
    const first=getAnalystControlToolBinders();
    expect(getAnalystControlToolBinders()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.map((binder)=>binder.name)).toEqual(bindToolProvider('analyst', first, context).tools.map((tool)=>tool.name));
  });

  it('binds the Analyst surface in the compiled configured tool order', () => {
    const surface = bindConfiguredAnalystSurface();
    expect([...surface.tools.keys()]).toEqual(TEST_WORKFLOWS.analyst.tools.map((tool) => tool.name));
  });

  it('selects type only during creation and exposes no post-creation edit or update input', () => {
    const tools = bindToolProvider('analyst', getAnalystControlToolBinders(), context).tools;
    const registered = new Map(tools.map((tool) => [tool.name, tool]));
    const mutationNames = ['create_card', 'reorder_child', 'reopen_card', 'cancel_card', 'delete_card'] as const;

    expect(mutationNames.filter((name) => registered.has(name))).toEqual(mutationNames);
    expect(tools.map(({ name }) => name))
      .not.toEqual(expect.arrayContaining(['edit_card', 'update_card']));
    expect(new Set(tools.map(({ name }) => name)).size).toBe(tools.length);
    expect(tools.every(({ executor }) => typeof executor === 'function')).toBe(true);
    expect(registered.get('create_card')!.inputSchema.safeParse({
      type: 'code',
      parent: 'project',
      title: 'Create once',
      bootstrap_content: 'Type is selected at creation.',
    }).success).toBe(true);
    expect(registered.get('create_card')!.inputSchema.safeParse({ type: 'code', title: 'Missing parent', bootstrap_content: 'Strict input.' }).success).toBe(false);
    expect(registered.get('create_card')!.inputSchema.safeParse({ type: 'code', parent: null, title: 'Null parent', bootstrap_content: 'Strict input.' }).success).toBe(false);
    expect(registered.get('create_card')!.inputSchema.safeParse({ type: 'code', parent: 'project', title: 'No legacy status', bootstrap_content: 'Strict input.', status: 'backlog' }).success).toBe(false);

    const postCreationInputs = new Map<string, Record<string, unknown>>([
      ['reorder_child', { parentId: 'project', orderedChildIds: [] }],
      ['reopen_card', { cardId: 'card-a' }],
      ['cancel_card', { cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
      ['delete_card', { ids: ['card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'] }],
    ]);
    for (const [name, input] of postCreationInputs) {
      const schema = registered.get(name)!.inputSchema;
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, type: 'test' }).success).toBe(false);
    }
  });

  it('keeps restart_server stable across published authentication capability', () => {
    const names = (available: boolean) => bindToolProvider('analyst', getAnalystControlToolBinders(), { restartCapability: available ? { available: true, port: { schedule() {}, acknowledge: async () => {} } } : { available: false }, actor: 'analyst', surface: 'web-chat',cardTypeVocabulary } as never).tools.map(({ name }) => name);
    expect(names(false)).toContain('restart_server');
    expect(names(true)).toContain('restart_server');
  });
});
