import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore } from '../../src/cards/card-store.js';
import { AnalystHandler } from '../../src/agents/analyst-handler.js';
import { ANALYST_TOOL_DEFINITIONS } from '../../src/agents/analyst-tool-schemas.js';
import { TOOL_REGISTRY, getAnalystSystemPrompt } from '../../src/agents/analyst-llm-resolver.js';
import { delete_card, reconfigure } from '../../src/agents/analyst-tools.js';
import { CONFIRMATION_TTL_MS } from '../../src/agents/analyst-tool-runner.js';
import type { ToolContext } from '../../src/agents/analyst-tools.js';
import { ActiveRuntime } from '../../src/runtime/active-runtime.js';
import { initRuntimeState } from '../../src/runtime/state.js';
import { startProcess, killProcess } from '../../src/runtime/process-runner.js';
import { loadConfig } from '../../src/agents/config-schema.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';

const TEST_MODEL = 'test-analyst-model';

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
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, position: 0, title: 'project', description: '', status: 'backlog', subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, assigned_to: null, depends_on: [], blocks: [], related: [], acceptance: '', result: null, metrics: null, artifacts: [], attachments: [], estimate: null, started_at: null, completed_at: null, duration_ms: null, error: null, retries: 0, version_seq: 1 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  initRuntimeState(root);
  return root;
}

function seedDeleteCards(root: string): CardStore {
  const store = new CardStore(root);
  store.create({ type: 'goal', parent: 'project', title: 'Goal', description: 'Goal', status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0, id: 'goal-1' });
  for (const id of ['code-1', 'code-2', 'code-3']) store.create({ type: 'code', parent: 'goal-1', title: id, description: id, status: 'backlog', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0, id });
  return store;
}

function toolResponse(tool: string, args: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: TEST_MODEL, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Tool inventory mirrors SPEC-r7 capability classes', () => {
  it('exposes registry, schema, policy, and prompt names without retired note-inbox tools', () => {
    const names = Object.keys(TOOL_REGISTRY).sort();
    expect(ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name).sort()).toEqual(names);
    for (const retired of ['add_note', 'list_notes', 'get_note', 'mark_note_handled']) expect(names).not.toContain(retired);
    for (const required of ['start_project','stop_project','terminate_process','queue_notification','reorder_child','navigate_workspace','navigate_back','show_config','restart_server','reconfigure','abort_goal_subtree','restart_card_or_subtree']) expect(names).toContain(required);
    const prompt = getAnalystSystemPrompt();
    for (const capability of ['Inspect','Navigate the workspace area','Mutate cards','Queue notifications','Control the runtime','Reconfigure','Investigate and repair']) expect(prompt).toContain(capability);
  });
});

describe('Contract C1 unsupported-action reply', () => {
  afterEach(() => { jest.restoreAllMocks(); });
  it('returns the unsupported-action template when policy denies a proposed tool', async () => {
    const root = setupRoot();
    try {
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => toolResponse('not_a_tool', {}));
      const response = await new AnalystHandler(root).handleMessage('s-c1', 'perform unsupported action');
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
      const proc = startProcess(root, 'sleep 30', { cardId: 'code-2', requiredForCardCompletion: true, ownerKind: 'runtime' });
      procId = proc.id;
      store.update('code-2', { status: 'running' });
      const result = await delete_card({ projectRoot: root, store, actor: 'analyst', surface: 'web-chat', confirmedDestructive: true }, { ids: ['code-1', 'code-2', 'code-3'] });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ partial: true, total: 3, succeeded: 2 });
      const data = result.data as { failures: Array<{ id: string; reason: string }>; totals?: unknown };
      expect(data.totals).toBeUndefined();
      expect(data.failures).toHaveLength(1);
      expect(data.failures[0]).toEqual({ id: 'code-2', reason: expect.stringContaining("delete_card denied by permission matrix") });
    } finally { if (procId) await killProcess(root, procId, 'SIGTERM'); rmSync(root, { recursive: true, force: true }); }
  });

  afterEach(() => { jest.restoreAllMocks(); });
  it('emits the literal C2 text after confirmed destructive fan-out', async () => {
    const root = setupRoot();
    let procId: string | undefined;
    try {
      const store = seedDeleteCards(root);
      const proc = startProcess(root, 'sleep 30', { cardId: 'code-2', requiredForCardCompletion: true, ownerKind: 'runtime' });
      procId = proc.id;
      store.update('code-2', { status: 'running' });
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => toolResponse('delete_card', { ids: ['code-1', 'code-2', 'code-3'] }));
      const handler = new AnalystHandler(root);
      const preview = await handler.handleMessage('s-c2', 'delete code cards');
      expect(preview.message.content).toContain('About to delete card delete_card. This will affect 3 item(s): code-1, code-2, code-3.');
      const confirmed = await handler.handleMessage('s-c2', 'yes');
      expect(confirmed.message.content).toContain('Partial success: 2 of 3 succeeded. Failed: code-2. Reasons: delete_card denied by permission matrix');
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
      const response = await new AnalystHandler(root).handleMessage('s-c3', 'queue a notification');
      expect(response.message.content).toContain('The Analyst cannot perform queue_notification; it is not a registered capability.');
      registry['queue_notification'] = saved;
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Contract C4 conversational confirmation flow', () => {
  afterEach(() => { jest.restoreAllMocks(); });


  it('emits stale-affirmation and amendment templates', async () => {
    const root = setupRoot();
    try {
      seedDeleteCards(root);
      const dateSpy = jest.spyOn(Date, 'now');
      const baseNow = 1_700_000_000_000;
      dateSpy.mockReturnValue(baseNow);
      jest.spyOn(globalThis, 'fetch')
        .mockImplementationOnce(async () => toolResponse('delete_card', { ids: ['code-1'] }))
        .mockImplementationOnce(async () => toolResponse('delete_card', { ids: ['code-1'] }))
        .mockImplementationOnce(async () => toolResponse('delete_card', { ids: ['code-2'] }));
      const handler = new AnalystHandler(root);
      await handler.handleMessage('s-c4-stale', 'delete code-1');
      dateSpy.mockReturnValue(baseNow + CONFIRMATION_TTL_MS + 1);
      const stale = await handler.handleMessage('s-c4-stale', 'yes');
      expect(stale.message.content).toBe('The previous confirmation expired. Restate the request if you still want it.');

      dateSpy.mockReturnValue(baseNow + 10);
      await handler.handleMessage('s-c4-amend', 'delete code-1');
      const amended = await handler.handleMessage('s-c4-amend', 'delete code-2 instead');
      expect(amended.message.content).toBe("Amended. New proposal: delete card delete_card. Reply 'yes' to proceed, 'no' to cancel, or describe a further amendment.");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });



  it('requires C4 confirmation for mark_goal_needs_corrections', async () => {
    const root = setupRoot();
    try {
      seedDeleteCards(root);
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => toolResponse('mark_goal_needs_corrections', { goalId: 'goal-1', issues: [{ summary: 'needs fixes' }] }));
      const response = await new AnalystHandler(root).handleMessage('s-c4-corrections', 'mark goal needs corrections');
      expect(response.message.content).toBe("About to mark goal needs corrections mark_goal_needs_corrections. This will affect 1 item(s): goal-1. Reply 'yes' to proceed, 'no' to cancel, or describe an amendment.");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('previews, cancels, and does not delete until an affirmative confirmation', async () => {
    const root = setupRoot();
    try {
      const store = seedDeleteCards(root);
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => toolResponse('delete_card', { ids: ['code-1'] }));
      const handler = new AnalystHandler(root);
      const preview = await handler.handleMessage('s-c4', 'delete code-1');
      expect(preview.message.content).toBe("About to delete card delete_card. This will affect 1 item(s): code-1. Reply 'yes' to proceed, 'no' to cancel, or describe an amendment.");
      expect(store.read('code-1')).not.toBeNull();
      const cancelled = await handler.handleMessage('s-c4', 'no');
      expect(cancelled.message.content).toBe('Cancelled. No changes were made.');
      expect(store.read('code-1')).not.toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Reconfigure MCP live manager refresh', () => {
  it('adds, edits, and removes MCP servers in active manager state', async () => {
    const root = setupRoot();
    try {
      const config = loadConfig(root).config;
      const activeRuntime = new ActiveRuntime(root, config);
      const mcpManager = new McpManager(root);
      activeRuntime.setMcpManager(mcpManager);
      const ctx: ToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat', activeRuntime };

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
      await activeRuntime.stop().catch(() => undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
