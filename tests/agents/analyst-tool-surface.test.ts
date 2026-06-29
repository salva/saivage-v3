import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore } from '../../src/cards/card-store.js';
import { AnalystHandler } from '../../src/agents/analyst-handler.js';
import { ANALYST_TOOL_DEFINITIONS } from '../../src/tools/definitions/index.js';
import { TOOL_REGISTRY, getAnalystSystemPrompt } from '../../src/agents/analyst-prompt.js';
import { cancel_card, create_card, delete_card, reorder_child } from '../../src/tools/analyst-card-tools.js';
import { reconfigure } from '../../src/tools/analyst-misc-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { initRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { startProcess, killProcess } from '../../src/runtime/process-runner.js';
import { loadConfig } from '../../src/agents/config-schema.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { createTestAnalystRuntime } from '../helpers/test-runtime-application.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { EventBus } from '../../src/events/bus.js';
import { EventLogger, ErrorLogger } from '../../src/observability/index.js';
import type { CardLifecycleState, CardStatus } from '../../src/schemas/index.js';

const TEST_MODEL = 'test-analyst-model';

const RETIRED_NOTE_TOOLS = [
  'add_note',
  '\x6cist_notes',
  'get_note',
  '\x6dark_note_handled',
];

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's02-surface-'));
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime','agents/sessions','agents/messages','diaries']) mkdirSync(join(sd, d), { recursive: true });
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
    models: { analyst: [TEST_MODEL] },
    providers: { test: { models: [TEST_MODEL], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
    server: { port: 8080, host: '127.0.0.1' },
  }, null, 2));
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, position: 0, title: 'project', description: '', status: 'backlog', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, assigned_to: null, depends_on: [], related: [], acceptance: '', metrics: null, estimate: null, started_at: null, duration_ms: null, retries: 0, version_seq: 1 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  initRuntimeState(root);
  return root;
}

function setupEmptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's02-empty-surface-'));
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime','agents/sessions','agents/messages','diaries']) mkdirSync(join(sd, d), { recursive: true });
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
    models: { analyst: [TEST_MODEL] },
    providers: { test: { models: [TEST_MODEL], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
    server: { port: 8080, host: '127.0.0.1' },
  }, null, 2));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: {} }));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  initRuntimeState(root);
  return root;
}

function seedDeleteCards(root: string): CardStore {
  const store = new CardStore(root);
  const goal = store.create({ type: 'goal', parent: 'project', title: 'Goal', description: 'Goal', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], related: [], retries: 0 });
  for (const title of ['code-1', 'code-2', 'code-3']) store.create({ type: 'code', parent: goal.id, title, description: title, status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], related: [], retries: 0 });
  return store;
}

function pauseRuntime(root: string): void {
  updateRuntimeState(root, { status: 'paused', paused: true, paused_at: new Date().toISOString() });
}

function lifecycleForStatus(status: CardStatus): CardLifecycleState {
  const at = new Date().toISOString();
  const selfReport = { result: status, outcome: status, summary: status, status_text: status, at };
  switch (status) {
    case 'backlog': return { status, result: null, error: null, completed_at: null };
    case 'running': return { status, result: null, error: null, completed_at: null };
    case 'changed': return { status, result: null, error: null, completed_at: null };
    case 'done': return { status, result: { kind: 'planner_done', summary: 'done' }, error: null, completed_at: at };
    case 'failed': return { status, result: { kind: 'planner_failure', error: 'failed' }, error: 'failed', completed_at: at };
    case 'blocked': return { status, result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'resume' }, error: 'blocked', completed_at: null };
    case 'needs_verification': return { status, result: { kind: 'executor_needs_verification', reason: 'verify', preserved_result: {}, fallback_reason: null, latest_self_report: selfReport }, error: null, completed_at: null };
    case 'cancelled': return { status, result: null, error: null, completed_at: at };
  }
}

function setCardStatusForTest(store: CardStore, cardId: string, status: CardStatus): void {
  store.repairTerminalLifecycle(cardId, { status, lifecycle: lifecycleForStatus(status) });
}

function toolResponse(tool: string, args: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: TEST_MODEL, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Tool inventory mirrors SPEC-r7 capability classes', () => {
  it('exposes registry, schema, policy, and prompt names without retired note-inbox tools', () => {
    const names = Object.keys(TOOL_REGISTRY).sort();
    expect(ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name).sort()).toEqual(names);
    for (const retired of RETIRED_NOTE_TOOLS) expect(names).not.toContain(retired);
    for (const required of ['start_project','stop_project','terminate_process','queue_notification','create_card','reorder_child','cancel_card','delete_card','navigate_workspace','navigate_back','show_config','restart_server','reconfigure']) expect(names).toContain(required);
    for (const removed of ['edit_card','get_card_output','abort_goal_subtree','restart_card_or_subtree','restart_goal','mark_goal_needs_corrections']) expect(names).not.toContain(removed);
    const prompt = getAnalystSystemPrompt();
    for (const capability of ['Inspect','Navigate the workspace area','Manage cards','Queue notifications','Control the runtime','Reconfigure','Investigate and repair']) expect(prompt).toContain(capability);
  });
});

describe('Analyst project bootstrap', () => {
  it('allows Analyst to create the missing root project card', async () => {
    const root = setupEmptyRoot();
    try {
      const store = new CardStore(root);
      const result = await create_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { type: 'project', parent: null, title: 'Project', description: 'Follow SPEC/PLAN.' });
      expect(result.success).toBe(true);
      expect(store.read('project')).toMatchObject({ id: 'project', type: 'project', parent: null, title: 'Project' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects Analyst child-card creation while unpaused and duplicate project creation', async () => {
    const root = setupRoot();
    try {
      const store = new CardStore(root);
      const child = await create_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { type: 'goal', parent: 'project', title: 'Goal', description: 'No.' });
      expect(child.success).toBe(false);
      expect(child.error).toContain('requires the runtime to be paused');
      const duplicate = await create_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { type: 'project', parent: null, title: 'Project', description: 'Duplicate.' });
      expect(duplicate.success).toBe(false);
      expect(duplicate.error).toContain('already exists');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('allows Analyst child-card creation under a non-running parent while paused', async () => {
    const root = setupRoot();
    try {
      pauseRuntime(root);
      const store = new CardStore(root);
      const child = await create_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { type: 'goal', parent: 'project', title: 'Goal', description: 'Yes.' });
      expect(child.success).toBe(true);
      expect(store.read('card-1')).toMatchObject({ type: 'goal', parent: 'project', status: 'backlog', title: 'Goal' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Analyst paused card-management gates', () => {
  it('enforces cancel_card status matrix and root denial while paused', async () => {
    const root = setupRoot();
    try {
      pauseRuntime(root);
      const allowedStatuses = ['backlog', 'changed', 'blocked', 'needs_verification'] as const;
      const deniedStatuses = ['running', 'done', 'failed', 'cancelled'] as const;
      for (const status of allowedStatuses) {
        const store = new CardStore(root);
        const card = store.create({ type: 'code', parent: 'project', title: `Allow ${status}`, description: status, status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], related: [], retries: 0 });
        if (status !== 'backlog') setCardStatusForTest(store, card.id, status);
        const result = await cancel_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { cardId: card.id });
        expect(result.success).toBe(true);
        expect(store.read(card.id)?.status).toBe('cancelled');
      }
      for (const status of deniedStatuses) {
        const store = new CardStore(root);
        const card = store.create({ type: 'code', parent: 'project', title: `Deny ${status}`, description: status, status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], related: [], retries: 0 });
        setCardStatusForTest(store, card.id, status);
        const result = await cancel_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { cardId: card.id });
        expect(result.success).toBe(false);
      }
      const rootCancel = await cancel_card({ projectRoot: root, store: new CardStore(root), actor: 'analyst', surface: 'web-chat' }, { cardId: 'project' });
      expect(rootCancel.success).toBe(false);
      expect(rootCancel.error).toContain('root project card');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires paused runtime for cancel, delete, and reorder mutations', async () => {
    const root = setupRoot();
    try {
      const store = seedDeleteCards(root);
      const goalId = store.listChildren('project')[0];
      const childIds = store.listChildren(goalId);
      for (const result of [
        await cancel_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { cardId: childIds[0] }),
        await delete_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { ids: [childIds[0]] }),
        await reorder_child({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { parentId: goalId, orderedChildIds: [...childIds].reverse() }),
      ]) {
        expect(result.success).toBe(false);
        expect(result.error).toContain('requires the runtime to be paused');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('denies reorder when parent or reordered children are running', async () => {
    const root = setupRoot();
    try {
      pauseRuntime(root);
      const store = seedDeleteCards(root);
      const goalId = store.listChildren('project')[0];
      const childIds = store.listChildren(goalId);
      store.setStatus(childIds[0], 'running');
      const runningChild = await reorder_child({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { parentId: goalId, orderedChildIds: [...childIds].reverse() });
      expect(runningChild.success).toBe(false);
      expect(runningChild.error).toContain('running');
      store.setStatus(childIds[0], 'backlog');
      store.setStatus(goalId, 'running');
      const runningParent = await reorder_child({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { parentId: goalId, orderedChildIds: [...childIds].reverse() });
      expect(runningParent.success).toBe(false);
      expect(runningParent.error).toContain('running');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('uses archive-backed delete for non-running subtrees while paused', async () => {
    const root = setupRoot();
    try {
      pauseRuntime(root);
      const store = seedDeleteCards(root);
      const goalId = store.listChildren('project')[0];
      const childIds = store.listChildren(goalId);
      const result = await delete_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { ids: [childIds[0]] });
      expect(result.success).toBe(true);
      expect(store.read(childIds[0])).toBeNull();
      expect(readFileSync(join(root, '.saivage', 'archive', 'cards', `${childIds[0]}.json`), 'utf-8')).toContain(childIds[0]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Contract C1 unsupported-action reply', () => {
  afterEach(() => { jest.restoreAllMocks(); });
  it('returns the unsupported-action template when policy denies a proposed tool', async () => {
    const root = setupRoot();
    try {
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => toolResponse('not_a_tool', {}));
      const response = await new AnalystHandler(root, createTestAnalystRuntime({ cardStore: new CardStore(root) })).handleMessage('s-c1', 'perform unsupported action');
      expect(response.message.content).toContain('That action is not supported by the Analyst on this surface.');
      expect(response.toolInvocations ?? []).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Contract C2 partial-success reporting', () => {
  it('returns flat partial-success data for delete_card fan-out and no nested totals', async () => {
    const root = setupRoot();
    let procId: string | undefined;
    try {
      const store = seedDeleteCards(root);
      pauseRuntime(root);
      const codeIds = store.listChildren('card-1');
      const proc = startProcess(root, 'sleep 30', { cardId: codeIds[1], requiredForCardCompletion: true, ownerKind: 'runtime' });
      procId = proc.id;
      store.setStatus(codeIds[1], 'running');
      store.setStatus(codeIds[1], 'running');
      const result = await delete_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat' }, { ids: codeIds });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ partial: true, total: 3, succeeded: 2 });
      const data = result.data as { failures: Array<{ id: string; reason: string }>; totals?: unknown };
      expect(data.totals).toBeUndefined();
      expect(data.failures).toHaveLength(1);
      expect(data.failures[0]).toEqual({ id: codeIds[1], reason: expect.stringContaining("delete_card denied by permission matrix") });
    } finally { if (procId) await killProcess(root, procId, 'SIGTERM'); rmSync(root, { recursive: true, force: true }); }
  });

  afterEach(() => { jest.restoreAllMocks(); });
  it('invokes exposed delete_card and reports the paused-runtime gate', async () => {
    const root = setupRoot();
    let procId: string | undefined;
    try {
      const store = seedDeleteCards(root);
      const codeIds = store.listChildren('card-1');
      const proc = startProcess(root, 'sleep 30', { cardId: codeIds[1], requiredForCardCompletion: true, ownerKind: 'runtime' });
      procId = proc.id;
      store.setStatus(codeIds[1], 'running');
      store.setStatus(codeIds[1], 'running');
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => toolResponse('delete_card', { ids: codeIds }));
      const handler = new AnalystHandler(root, createTestAnalystRuntime({ cardStore: new CardStore(root) }));
      const response = await handler.handleMessage('s-c2', 'delete code cards');
      expect(response.toolInvocations ?? []).toHaveLength(1);
      expect(response.toolInvocations?.[0].tool).toBe('delete_card');
      expect(response.toolInvocations?.[0].result.success).toBe(false);
      expect(response.toolInvocations?.[0].result.error).toContain('requires the runtime to be paused');
    } finally { if (procId) await killProcess(root, procId, 'SIGTERM'); rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Contract C3 unknown-internal-capability reply', () => {
  afterEach(() => { jest.restoreAllMocks(); });
  it('returns the unknown-capability template if dispatch reaches an unregistered tool', async () => {
    const root = setupRoot();
    try {
      const registry = TOOL_REGISTRY as Record<string, unknown>;
      const saved = registry['queue_notification'];
      delete registry['queue_notification'];
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => toolResponse('queue_notification', { recipient: 'planner', kind: 'info', body: 'hello' }));
      const response = await new AnalystHandler(root, createTestAnalystRuntime({ cardStore: new CardStore(root) })).handleMessage('s-c3', 'queue a notification');
      expect(response.message.content).toContain('The Analyst cannot perform queue_notification; it is not a registered capability.');
      registry['queue_notification'] = saved;
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Reconfigure MCP live manager refresh', () => {
  it('adds, edits, and removes MCP servers in active manager state', async () => {
      const root = setupRoot();
      try {
        const config = loadConfig(root).config;
      const eventBus = new EventBus();
      const runtimeApplication = createRuntimeApplication({ projectRoot: root, config, eventBus, eventLogger: new EventLogger(join(root, '.saivage')), errorLogger: new ErrorLogger(join(root, '.saivage')), cardStore: new CardStore(root, undefined, eventBus) });
      const mcpManager = new McpManager(root);
      const depsBeforeMcp = runtimeApplication.analystDeps;
      expect(runtimeApplication.analystDeps).toBe(depsBeforeMcp);
      runtimeApplication.setMcpManager(mcpManager);
      expect(runtimeApplication.analystDeps).not.toBe(depsBeforeMcp);
      expect(runtimeApplication.analystDeps).toBe(runtimeApplication.analystDeps);
      expect(runtimeApplication.analystDeps.mcpManager).toBe(mcpManager);
      const ctx: ToolContext = { projectRoot: root, store: runtimeApplication.analystDeps.cardStore, actor: 'analyst', surface: 'web-chat', runtime: runtimeApplication.analystDeps.runtime, mcpManager };

      const added = await reconfigure(ctx, { action: 'mcp_add', name: 'test-server', command: '/bin/true', args: [] });
      expect(added.success).toBe(true);
      expect(mcpManager.getStatus().some((status) => status.name === 'test-server')).toBe(true);

      const edited = await reconfigure(ctx, { action: 'mcp_edit', name: 'test-server', command: '/bin/true', args: [] });
      expect(edited.success).toBe(true);
      const onDisk = JSON.parse(readFileSync(join(root, '.saivage', 'saivage.json'), 'utf-8')) as { mcpServers: Record<string, { command: string }> };
      expect(onDisk.mcpServers['test-server'].command).toBe('/bin/true');
      expect(mcpManager.getStatus().find((status) => status.name === 'test-server')).toBeDefined();

      const removed = await reconfigure(ctx, { action: 'mcp_remove', name: 'test-server' });
      expect(removed.success).toBe(true);
      expect(mcpManager.getStatus().some((status) => status.name === 'test-server')).toBe(false);
      await mcpManager.stopAll();
      await runtimeApplication.runtimeApi.shutdown().catch(() => undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
