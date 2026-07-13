import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';



import { AnalystRuntime } from '../../src/agents/analyst-handler.js';
import { ANALYST_CONTROL_TOOLS, ANALYST_SHARED_PROVIDER_TOOL_NAMES, ANALYST_TOOL_DEFINITIONS } from '../../src/tools/analyst-tool-registry.js';
import { cancel_card, create_card, delete_card, reorder_child } from '../../src/tools/analyst-card-tools.js';
import { reconfigure } from '../../src/tools/analyst-misc-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { buildRoleSurface } from '../../src/tools/role-invocation-surfaces.js';
import { initRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { createTestAnalystRuntime } from '../helpers/test-runtime-application.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { EventBus } from '../../src/events/bus.js';
import { EventLogger, ErrorLogger } from '../../src/observability/index.js';
import type { CardLifecycleState, CardStatus } from '../../src/schemas/index.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { readDeletedCardIds } from '../../src/persistence/deleted-card-ids.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { formatVocabularySnippet } from '../../src/agents/analyst-prompt.js';
import { formatPromptToolList } from '../../src/utils/prompt-api.js';
import { readConversationMessages } from '../../src/runtime/actors/conversation-store.js';
import { resolveAnalystSessionId } from '../../src/agents/session-ids.js';

const TEST_MODEL = 'test-analyst-model';

const RETIRED_NOTE_TOOLS = [
  'add_note',
  '\x6cist_notes',
  'get_note',
  '\x6dark_note_handled',
];

const RETIRED_ACTIVE_SURFACE_TOOLS = [
  'add_note',
  'list_notes',
  'get_note',
  'mark_note_handled',
  'create_plan',
  'update_plan',
  'edit_card',
  'get_card_output',
  'abort_goal_subtree',
  'restart_card_or_subtree',
  'restart_goal',
  'mark_goal_needs_corrections',
  'write_file',
  'terminate_process',
  'emit_result',
];

const TEST_BRIEF = '# Goal\n\nFollow SPEC/PLAN.\n\n# Instructions\n\nUse record-backed cards.\n\n# Acceptance Criteria\n\nDone.\n';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's02-surface-'));
  const sd = join(root, '.saivage');
  initProjectTree(root);
  writeFileSync(join(sd, 'saivage.yaml'), YAML.stringify({
    models: { default: [TEST_MODEL], analyst: [TEST_MODEL] },
    providers: { test: { models: [TEST_MODEL], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
    server: { port: 8080, host: '127.0.0.1' },
  }));
  initRuntimeState(root);
  return root;
}

function setupEmptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's02-empty-surface-'));
  const sd = join(root, '.saivage');
  initProjectTree(root);
  writeFileSync(join(sd, 'saivage.yaml'), YAML.stringify({
    models: { default: [TEST_MODEL], analyst: [TEST_MODEL] },
    providers: { test: { models: [TEST_MODEL], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
    server: { port: 8080, host: '127.0.0.1' },
  }));
  initRuntimeState(root);
  return root;
}

function seedDeleteCards(root: string): CardStore {
  const store = new CardStore(root);
  const goal = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'Goal', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
  for (const title of ['code-1', 'code-2', 'code-3']) store.create({ type: 'code', parent: goal.id, title, brief: title, status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
  return store;
}

function pauseRuntime(root: string): void {
  updateRuntimeState(root, { status: 'paused' });
}

function loadTestConfig(root: string) {
  return loadEnvironment(['node', 'test', '--project-root', root], process.env).config;
}

function lifecycleForStatus(status: CardStatus): CardLifecycleState {
  const at = new Date().toISOString();
  switch (status) {
    case 'backlog': return { status, result: null, error: null, completed_at: null };
    case 'running': return { status, result: null, error: null, completed_at: null };
    case 'changed': return { status, result: null, error: null, completed_at: null };
    case 'done': return { status, result: { kind: 'done', summary: 'done' }, error: null, completed_at: at };
    case 'failed': return { status, result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: at };
    case 'blocked': return { status, result: { kind: 'blocked', summary: 'blocked', resume_reason: 'resume' }, error: 'blocked', completed_at: null };
    case 'cancelled': return { status, result: null, error: null, completed_at: at };
  }
}

function setCardStatusForTest(store: CardStore, cardId: string, status: CardStatus): void {
  store.repairTerminalLifecycle(cardId, { status, lifecycle: lifecycleForStatus(status) });
}

function toolCtx(root: string, store: CardStore, overrides: Partial<ToolContext> = {}): ToolContext {
  const processRunner = overrides.processRunner ?? createTestProcessRunner(root);
  return { projectRoot: root, processRunner, processScope: overrides.processScope ?? processRunner.createDirectScope(processRunner.analystRootScope, 'test-analyst', 'operator_session'), store, actor: 'analyst', surface: 'web-chat', restartServerAvailable: false, ...overrides };
}

function toolResponse(tool: string, args: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: TEST_MODEL, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function messageResponse(content: string): Response {
  return new Response(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: TEST_MODEL, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function createProductionShapedAnalystSurface(root: string, store: CardStore): ReturnType<typeof buildRoleSurface> {
  const ctx: ToolContext = toolCtx(root, store, { sessionId: 'analyst:test' });
  return buildRoleSurface('analyst', { projectRoot: root, toolContext: ctx, store, processRunner: ctx.processRunner, processScope: ctx.processScope, sessionId: ctx.sessionId, ownerId: ctx.sessionId ?? 'analyst', mcpManagerProvider: () => undefined });
}

function renderAnalystPrompt(root: string, tools = ANALYST_TOOL_DEFINITIONS): string {
  return createTestPromptTemplateRegistry().render('analyst', 'analyst', {
    toolList: formatPromptToolList(tools),
    vocabularySnippet: formatVocabularySnippet(),
    projectContext: '{"projectRoot":"test"}',
  });
}

describe('Tool inventory mirrors SPEC-r7 capability classes', () => {
  it('exposes registry, schema, policy, and prompt names without retired note-inbox tools', () => {
    const names = ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name).sort();
    for (const retired of RETIRED_NOTE_TOOLS) expect(names).not.toContain(retired);
    for (const required of ['start_project','pause_runtime','resume_runtime','restart_server','queue_notification','create_card','reorder_child','cancel_card','delete_card','navigate_workspace','navigate_back','show_config','reconfigure']) expect(names).toContain(required);
    expect(names).not.toContain('stop_project');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('terminate_process');
    for (const removed of ['edit_card','get_card_output','abort_goal_subtree','restart_card_or_subtree','restart_goal','mark_goal_needs_corrections']) expect(names).not.toContain(removed);
    const prompt = renderAnalystPrompt(process.cwd());
    for (const capability of ['Inspect','Navigate','Manage cards','Queue notifications','Control the runtime','Reconfigure','Investigate and repair']) expect(prompt).toContain(capability);
    expect(prompt).toContain('Registered tools:');
  });

  it('renders the Analyst prompt from the production-shaped invocation surface including provider tools', () => {
    const root = setupRoot();
    try {
      const surface = createProductionShapedAnalystSurface(root, new CardStore(root));
      const tools = surfaceToolDefinitions(surface);
      const toolNames = tools.map((tool) => tool.function.name);
      expect(toolNames).toEqual(expect.arrayContaining([...ANALYST_SHARED_PROVIDER_TOOL_NAMES]));

      const prompt = renderAnalystPrompt(root, tools);
      for (const providerTool of ['read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'run_command', 'webfetch', 'skill', 'mcp_tool_call']) {
        expect(prompt).toContain(`- ${providerTool}:`);
      }

      const registeredNames = new Set(toolNames);
      for (const staticProviderReference of ['read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'run_command', 'webfetch', 'skill', 'mcp_tool_call']) {
        expect(registeredNames.has(staticProviderReference)).toBe(true);
        expect(prompt).toMatch(new RegExp(`- ${staticProviderReference}:`));
      }
      const grepToolLine = prompt.split('\n').find((line) => line.startsWith('- grep:'));
      expect(grepToolLine).toContain('under project:///, record:///, tmp:///, read-only work:///, or system:/// paths');
      expect(grepToolLine).toContain('grep record:///<cardId> searches the latest closed versions of exposed record slots');
      expect(grepToolLine).toContain('returns record URLs as path');
      for (const retiredTool of RETIRED_ACTIVE_SURFACE_TOOLS) expect(prompt).not.toMatch(new RegExp(`- ${retiredTool}:`));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('exposes Analyst shared provider tools through the active invocation surface', () => {
    const root = setupRoot();
    try {
      const runtime = new AnalystRuntime({ projectRoot: root, promptTemplates: createTestPromptTemplateRegistry(), config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root, cardStore: new CardStore(root) }) });

      const names = runtime.getAvailableToolNames();
      expect(names).toEqual(expect.arrayContaining(['list_cards', 'get_card', 'get_tree', 'list_card_history', 'get_card_history_entry', 'diff_card', 'skill', 'mcp_tool_call', 'websearch', 'webfetch', 'run_command']));
      expect(names).not.toEqual(expect.arrayContaining(RETIRED_ACTIVE_SURFACE_TOOLS));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Analyst project bootstrap', () => {
  it('rejects Analyst root project bootstrap because init creates the root card', async () => {
    const root = setupEmptyRoot();
    try {
      const store = new CardStore(root);
      const result = await create_card(toolCtx(root, store), { type: 'project', parent: null, title: 'Project', brief: TEST_BRIEF });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Root project card already exists');
      expect(store.read('project')).toMatchObject({ id: 'project', type: 'project', parent: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('allows Analyst child-card creation while stopped and rejects duplicate project creation', async () => {
    const root = setupRoot();
    try {
      const store = new CardStore(root);
      const child = await create_card(toolCtx(root, store), { type: 'goal', parent: 'project', title: 'Goal', brief: TEST_BRIEF });
      expect(child.success).toBe(true);
      const duplicate = await create_card(toolCtx(root, store), { type: 'project', parent: null, title: 'Project', brief: TEST_BRIEF });
      expect(duplicate.success).toBe(false);
      expect(duplicate.error).toContain('already exists');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('allows Analyst child-card creation under a non-running parent while paused', async () => {
    const root = setupRoot();
    try {
      pauseRuntime(root);
      const store = new CardStore(root);
      const child = await create_card(toolCtx(root, store), { type: 'goal', parent: 'project', title: 'Goal', brief: TEST_BRIEF });
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
      const allowedStatuses = ['backlog', 'changed', 'blocked'] as const;
      const deniedStatuses = ['running', 'done', 'failed', 'cancelled'] as const;
      for (const status of allowedStatuses) {
        const store = new CardStore(root);
        const card = store.create({ type: 'code', parent: 'project', title: `Allow ${status}`, brief: status, status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
        if (status !== 'backlog') setCardStatusForTest(store, card.id, status);
        const result = await cancel_card(toolCtx(root, store), { cardId: card.id });
        expect(result.success).toBe(true);
        expect(store.read(card.id)?.status).toBe('cancelled');
      }
      for (const status of deniedStatuses) {
        const store = new CardStore(root);
        const card = store.create({ type: 'code', parent: 'project', title: `Deny ${status}`, brief: status, status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
        setCardStatusForTest(store, card.id, status);
        const result = await cancel_card(toolCtx(root, store), { cardId: card.id });
        expect(result.success).toBe(false);
      }
      const rootCancel = await cancel_card(toolCtx(root, new CardStore(root)), { cardId: 'project' });
      expect(rootCancel.success).toBe(false);
      expect(rootCancel.error).toContain('root project card');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires stopped or paused runtime for cancel, delete, and reorder mutations', async () => {
    const root = setupRoot();
    try {
      const store = seedDeleteCards(root);
      updateRuntimeState(root, { status: 'running' });
      const goalId = store.listChildren('project')[0];
      const childIds = store.listChildren(goalId);
      for (const result of [
        await cancel_card(toolCtx(root, store), { cardId: childIds[0] }),
        await delete_card(toolCtx(root, store), { ids: [childIds[0]] }),
        await reorder_child(toolCtx(root, store), { parentId: goalId, orderedChildIds: [...childIds].reverse() }),
      ]) {
        expect(result.success).toBe(false);
        expect(result.error).toContain('requires runtime status stopped or paused');
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
      const runningChild = await reorder_child(toolCtx(root, store), { parentId: goalId, orderedChildIds: [...childIds].reverse() });
      expect(runningChild.success).toBe(false);
      expect(runningChild.error).toContain('running');
      store.setStatus(childIds[0], 'backlog');
      store.setStatus(goalId, 'running');
      const runningParent = await reorder_child(toolCtx(root, store), { parentId: goalId, orderedChildIds: [...childIds].reverse() });
      expect(runningParent.success).toBe(false);
      expect(runningParent.error).toContain('running');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('deletes non-running subtrees while paused without archive side files', async () => {
    const root = setupRoot();
    try {
      pauseRuntime(root);
      const store = seedDeleteCards(root);
      const goalId = store.listChildren('project')[0];
      const childIds = store.listChildren(goalId);
      const result = await delete_card(toolCtx(root, store), { ids: [childIds[0]] });
      expect(result.success).toBe(true);
      expect(store.read(childIds[0])).toBeNull();
      expect(readDeletedCardIds(root)).toContain(childIds[0]);
      expect(existsSync(join(root, '.saivage', 'archive'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Contract C1 unsupported-action reply', () => {
  afterEach(() => { jest.restoreAllMocks(); });
  it('returns the unsupported-action template when policy denies a proposed tool', async () => {
    const root = setupRoot();
    try {
      let call = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call += 1;
        if (call === 1) return toolResponse('not_a_tool', {});
        return messageResponse('That action is not supported by the Analyst on this surface.');
      });
      const runtime = new AnalystRuntime({ projectRoot: root, promptTemplates: createTestPromptTemplateRegistry(), config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root, cardStore: new CardStore(root) }) });
      const response = await runtime.submit('s-c1', { userContent: 'perform unsupported action' });
      const assistantText = readConversationMessages(root, resolveAnalystSessionId('s-c1')).filter((message) => message.role === 'assistant' && message.kind === 'text').at(-1)?.content;
      expect(assistantText).toContain('That action is not supported by the Analyst on this surface.');
      expect(response.toolInvocations ?? []).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Contract C2 partial-success reporting', () => {
  it('returns flat partial-success data for delete_card fan-out and no nested totals', async () => {
    const root = setupRoot();
    const processRunner = createTestProcessRunner(root);
    try {
      const store = seedDeleteCards(root);
      pauseRuntime(root);
      const codeIds = store.listChildren('card-1');
      const processScope = processRunner.createDirectScope(processRunner.runtimeRootScope, 'test-runtime', 'runtime_card');
      const proc = processRunner.spawn({ command: 'sleep 30', directScope: processScope, category: 'runtime_card', cardId: codeIds[1], ownerId: 'runtime:test', ownerKind: 'runtime', requiredForCardCompletion: true });
      store.setStatus(codeIds[1], 'running');
      store.setStatus(codeIds[1], 'running');
      const result = await delete_card(toolCtx(root, store), { ids: codeIds });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ partial: true, total: 3, succeeded: 2 });
      const data = result.data as { failures: Array<{ id: string; reason: string }>; totals?: unknown };
      expect(data.totals).toBeUndefined();
      expect(data.failures).toHaveLength(1);
      expect(data.failures[0]).toEqual({ id: codeIds[1], reason: expect.stringContaining("delete_card denied by permission matrix") });
    } finally { await processRunner.terminateScopeTree({ rootScope: processRunner.runtimeRootScope, categories: ['runtime_card'], reason: 'test cleanup', graceMs: 100 }); rmSync(root, { recursive: true, force: true }); }
  });

  afterEach(() => { jest.restoreAllMocks(); });
  it('invokes exposed delete_card and reports partial success while stopped', async () => {
    const root = setupRoot();
    const processRunner = createTestProcessRunner(root);
    try {
      const store = seedDeleteCards(root);
      const codeIds = store.listChildren('card-1');
      const processScope = processRunner.createDirectScope(processRunner.runtimeRootScope, 'test-runtime', 'runtime_card');
      const proc = processRunner.spawn({ command: 'sleep 30', directScope: processScope, category: 'runtime_card', cardId: codeIds[1], ownerId: 'runtime:test', ownerKind: 'runtime', requiredForCardCompletion: true });
      store.setStatus(codeIds[1], 'running');
      store.setStatus(codeIds[1], 'running');
      let call = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call += 1;
        if (call === 1) return toolResponse('delete_card', { ids: codeIds });
        return messageResponse('Partial delete completed; one card could not be deleted.');
      });
      const runtime = new AnalystRuntime({ projectRoot: root, promptTemplates: createTestPromptTemplateRegistry(), config: loadTestConfig(root), runtimeDeps: createTestAnalystRuntime({ projectRoot: root, cardStore: new CardStore(root) }) });
      const response = await runtime.submit('s-c2', { userContent: 'delete code cards' });
      expect(response.toolInvocations ?? []).toHaveLength(1);
      expect(response.toolInvocations?.[0].tool).toBe('delete_card');
      expect(response.toolInvocations?.[0].result.success).toBe(true);
      if (!response.toolInvocations?.[0].result.success) throw new Error('Expected successful delete_card result.');
      expect(response.toolInvocations[0].result.data).toMatchObject({ partial: true, succeeded: 2 });
    } finally { await processRunner.terminateScopeTree({ rootScope: processRunner.runtimeRootScope, categories: ['runtime_card'], reason: 'test cleanup', graceMs: 100 }); rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Reconfigure MCP live manager refresh', () => {
  it('adds, edits, and removes MCP servers in active manager state', async () => {
      const root = setupRoot();
      try {
        const config = loadTestConfig(root);
      const eventBus = new EventBus();
      const runtimeApplication = createRuntimeApplication({ projectRoot: root, config, eventBus, eventLogger: new EventLogger(join(root, '.saivage')), errorLogger: new ErrorLogger(join(root, '.saivage')), cardStore: new CardStore(root, eventBus), readModelChanges: new ReadModelChangeBroadcaster() });
      const mcpManager = new McpManager(root, { config, processRunner: runtimeApplication.processRunner });
      const depsBeforeMcp = runtimeApplication.analystDeps;
      expect(runtimeApplication.analystDeps).toBe(depsBeforeMcp);
      runtimeApplication.setMcpManager(mcpManager);
      expect(runtimeApplication.analystDeps).not.toBe(depsBeforeMcp);
      expect(runtimeApplication.analystDeps.mcpManager).toBe(mcpManager);
      const ctx: ToolContext = toolCtx(root, runtimeApplication.analystDeps.cardStore, { runtime: runtimeApplication.analystDeps.runtime, mcpManager });

      const added = await reconfigure(ctx, { action: 'mcp_add', name: 'test-server', command: '/bin/true', args: [] });
      expect(added.success).toBe(true);
      expect(mcpManager.getStatus().some((status) => status.name === 'test-server')).toBe(true);

      const edited = await reconfigure(ctx, { action: 'mcp_edit', name: 'test-server', command: '/bin/true', args: [] });
      expect(edited.success).toBe(true);
      const onDisk = YAML.parse(readFileSync(join(root, '.saivage', 'saivage.yaml'), 'utf-8')) as { mcpServers: Record<string, { command: string }> };
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

describe('internal runtime shutdown', () => {
  it('cleans runtime-owned processes during application disposal without an Analyst tool', async () => {
    const root = setupRoot();
    const eventBus = new EventBus();
    const runtimeApplication = createRuntimeApplication({ projectRoot: root, config: loadTestConfig(root), eventBus, eventLogger: new EventLogger(join(root, '.saivage')), errorLogger: new ErrorLogger(join(root, '.saivage')), cardStore: new CardStore(root, eventBus), readModelChanges: new ReadModelChangeBroadcaster() });
    try {
      await runtimeApplication.runtimeApi.start();
      const processScope = runtimeApplication.processRunner.createDirectScope(runtimeApplication.processRunner.runtimeRootScope, 'test-runtime', 'runtime_card');
      const process = runtimeApplication.processRunner.spawn({ command: 'sleep 30', directScope: processScope, category: 'runtime_card', cardId: null, ownerId: 'runtime:test', ownerKind: 'runtime', requiredForCardCompletion: false });

      await runtimeApplication.runtimeApi.shutdown();

      expect(runtimeApplication.processRunner.get(process.id)?.status).toBe('killed');
      expect(runtimeApplication.runtimeApi.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    } finally {
      await runtimeApplication.runtimeApi.shutdown().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
