import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { getAuthPolicy, resetAuthPolicyForTests } from '../src/server/auth-policy.js';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../src/cards/card-store.js';
import { initRuntimeState, readRuntimeState, runtimeStatePath, updateRuntimeState } from '../src/runtime/state.js';
import {
  create_card, edit_card, delete_card, add_note, pause_runtime, resume_runtime,
} from '../src/agents/analyst-tools.js';
import type { ToolContext } from '../src/agents/analyst-tools.js';

import { AnalystHandler, getOrCreateAnalystSession } from '../src/agents/analyst-handler.js';
import {
  ANALYST_TOOL_DEFINITIONS,
  ANALYST_ISSUE_SEVERITY_VALUES,
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  NOTE_KIND_VALUES,
  URGENCY_VALUES,
} from '../src/agents/analyst-tool-schemas.js';
import { cardStatusSchema, cardTypeSchema, noteKindSchema, urgencySchema } from '../src/schemas/validators.js';

function uniqueDir(): string {
  return join(tmpdir(), `saivage-analyst-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function setupProject(projectRoot: string): void {
  const sd = join(projectRoot, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime','agents/sessions','agents/messages','diaries']) {
    mkdirSync(join(sd, d), { recursive: true });
  }
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
    server: { port: 0, host: '127.0.0.1' },
    models: { default: ['test-model'] },
    providers: { test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' } },
  }));
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({
    id: 'project', type: 'project', parent: null, depth: 0, title: 'project',
    description: '', status: 'backlog', subtype: null, tags: [], priority: 0,
    urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now,
    assigned_to: null, depends_on: [], blocks: [], related: [], acceptance: '',
    result: null, metrics: null, artifacts: [], attachments: [], estimate: null,
    started_at: null, completed_at: null, duration_ms: null, error: null, retries: 0, version_seq: 1,
  }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({
    cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } },
  }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  initRuntimeState(projectRoot);
}

function setupTestProject(projectRoot: string): CardStore {
  setupProject(projectRoot);
  const store = new CardStore(projectRoot);
  store.create({ type: 'goal', parent: 'project', title: 'Test Goal', description: 'A test goal', status: 'active', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0, id: 'goal-1' });
  store.activateGoal('goal-1');
  store.create({ type: 'code', parent: 'goal-1', title: 'Code Task 1', description: 'Implement feature', status: 'backlog', depth: 0, tags: ['code'], priority: 2, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0, id: 'code-1' });
  return store;
}

function ctx(projectRoot: string, store?: CardStore): ToolContext {
  return { projectRoot, store, actor: 'analyst', surface: 'web-chat' };
}

describe('Analyst Tool Definitions', () => {
  it('do not advertise removed plan card types', () => {
    const toolNames = ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name);
    expect(toolNames).not.toContain('create_plan');
    expect(toolNames).not.toContain('update_plan');
    expect(toolNames).toContain('create_card');
    expect(toolNames).toContain('list_card_history');
  });


  function toolByName(name: string) {
    const definition = ANALYST_TOOL_DEFINITIONS.find((tool) => tool.function.name === name);
    expect(definition).toBeDefined();
    return definition!;
  }

  function propertiesFor(name: string): Record<string, Record<string, unknown>> {
    const parameters = toolByName(name).function.parameters as { properties?: Record<string, Record<string, unknown>> };
    expect(parameters.properties).toBeDefined();
    return parameters.properties!;
  }

  it('keeps exported analyst enum vocabularies aligned with runtime validators', () => {
    expect([...CARD_STATUS_VALUES]).toEqual(cardStatusSchema.options);
    expect([...CARD_TYPE_VALUES]).toEqual(cardTypeSchema.options);
    expect([...URGENCY_VALUES]).toEqual(urgencySchema.options);
    expect([...NOTE_KIND_VALUES]).toEqual(noteKindSchema.options);
    expect([...ANALYST_ISSUE_SEVERITY_VALUES]).toEqual(['info', 'warning', 'blocker']);
  });

  it('emits enum JSON schema constraints and guidance for card, note, list, and corrections tools', () => {
    const createProps = propertiesFor('create_card');
    expect(createProps.type.enum).toEqual([...CARD_TYPE_VALUES]);
    expect(createProps.status.enum).toEqual([...CARD_STATUS_VALUES]);
    expect(createProps.urgency.enum).toEqual([...URGENCY_VALUES]);
    expect(createProps.status.description).toContain('Allowed values: drafting, backlog, active, running, blocked, changed, done, failed, cancelled, needs_verification.');
    expect(toolByName('create_card').function.description).toContain("There is no 'ready' status");

    const editProps = propertiesFor('edit_card');
    expect(editProps.status.enum).toEqual([...CARD_STATUS_VALUES]);
    expect(editProps.urgency.enum).toEqual([...URGENCY_VALUES]);
    expect(toolByName('edit_card').function.description).toContain("There is no 'ready' or 'todo' status");

    const listProps = propertiesFor('list_cards');
    expect(listProps.status.enum).toEqual([...CARD_STATUS_VALUES]);
    expect(listProps.type.enum).toEqual([...CARD_TYPE_VALUES]);

    const noteProps = propertiesFor('add_note');
    expect(noteProps.kind.enum).toEqual([...NOTE_KIND_VALUES]);
    expect(toolByName('add_note').function.description).toContain('do NOT change card fields');

    for (const name of ['mark_goal_needs_corrections']) {
      const issues = propertiesFor(name).issues as { items?: { properties?: Record<string, Record<string, unknown>> } };
      expect(issues.items?.properties?.severity.enum).toEqual([...ANALYST_ISSUE_SEVERITY_VALUES]);
      expect(issues.items?.properties?.severity.description).toContain('Allowed values: info, warning, blocker.');
    }
  });

  it('exports valid OpenAI-compatible ToolDefinition objects for LLM clients', () => {
    for (const definition of ANALYST_TOOL_DEFINITIONS) {
      expect(definition.type).toBe('function');
      expect(definition.function.name).toMatch(/^[a-z_]+$/);
      expect(typeof definition.function.description).toBe('string');
      expect(definition.function.description.length).toBeGreaterThan(0);
      expect(definition.function.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      const params = definition.function.parameters as { properties?: unknown; required?: unknown };
      expect(params.properties).toBeDefined();
      expect(Array.isArray(params.required)).toBe(true);
    }
  });
});

describe('Analyst Tools', () => {
  let projectRoot: string;
  let store: CardStore;

  beforeEach(() => {
    projectRoot = uniqueDir();
    store = setupTestProject(projectRoot);
  });
  afterEach(() => {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  });

  it('creates a card under goal, returns success with card data', async () => {
    const r = await create_card(ctx(projectRoot, store), { type: 'code', parent: 'goal-1', title: 'New Code Card', description: 'A new card' });
    expect(r.success).toBe(true);
    const c = r.data as Record<string, unknown>;
    expect(c.title).toBe('New Code Card');
    expect(c.parent).toBe('goal-1');
    expect(c.type).toBe('code');
    expect(c.id).toMatch(/^code-/);
  });



  it('denies delete_card for matrix-disallowed target states', async () => {
    store.update('goal-1', { status: 'running' });

    const result = await delete_card({ projectRoot, store, actor: 'runtime', surface: 'runtime' }, { id: 'goal-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain("delete_card denied by permission matrix");
    expect(result.error).toContain("card 'goal-1'");
    expect(result.error).toContain("state 'running'");
    expect(store.read('goal-1')).not.toBeNull();
  });

  it('denies delete_card when a descendant is matrix-disallowed', async () => {
    store.update('goal-1', { status: 'backlog' });
    store.update('code-1', { status: 'running' });

    const result = await delete_card({ projectRoot, store, actor: 'runtime', surface: 'runtime' }, { id: 'goal-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain("delete_card denied by permission matrix");
    expect(result.error).toContain("card 'code-1'");
    expect(result.error).toContain("state 'running'");
    expect(store.read('goal-1')).not.toBeNull();
    expect(store.read('code-1')).not.toBeNull();
  });

  it('allows delete_card for a matrix-allowed state', async () => {
    store.update('code-1', { status: 'backlog' });

    const result = await delete_card({ projectRoot, store, actor: 'runtime', surface: 'runtime' }, { id: 'code-1' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ deleted: ['code-1'] });
    expect(store.read('code-1')).toBeNull();
  });

  it('returns actionable enum preflight errors for invalid create_card values', async () => {
    const result = await create_card(ctx(projectRoot, store), {
      type: 'task' as never,
      parent: 'goal-1',
      title: 'Bad Card',
      description: 'Invalid type',
      status: 'ready' as never,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("create_card failed: field 'type' received 'task'");
    expect(result.error).toContain(`Allowed values: ${CARD_TYPE_VALUES.join(', ')}`);
    expect(result.error).toContain("See the 'create_card' tool's parameter schema");
  });

  it('returns actionable enum preflight errors for invalid edit_card status', async () => {
    const result = await edit_card({ projectRoot, store, actor: 'runtime', surface: 'runtime' }, {
      id: 'code-1',
      status: 'todo',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("edit_card failed: field 'status' received 'todo'");
    expect(result.error).toContain(`Allowed values: ${CARD_STATUS_VALUES.join(', ')}`);
    expect(result.error).toContain("See the 'edit_card' tool's parameter schema");
  });

  it('returns actionable enum preflight errors for invalid add_note kind', async () => {
    const result = await add_note(ctx(projectRoot, store), {
      cardId: 'code-1',
      content: 'use canonical note kind',
      kind: 'note' as never,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("add_note failed: field 'kind' received 'note'");
    expect(result.error).toContain(`Allowed values: ${NOTE_KIND_VALUES.join(', ')}`);
    expect(result.error).toContain("See the 'add_note' tool's parameter schema");
  });


  it('refuses resume_runtime while frozen and preserves frozen persisted state', async () => {
    updateRuntimeState(projectRoot, {
      status: 'frozen',
      paused: true,
      paused_at: '2025-01-01T00:00:00.000Z',
      frozen_reason: 'operator requested freeze',
    });

    const before = readRuntimeState(projectRoot);
    expect(before?.status).toBe('frozen');

    const result = await resume_runtime(ctx(projectRoot, store), {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('resume-from-freeze');
    expect(result.error).toContain('Runtime is frozen');

    const after = readRuntimeState(projectRoot);
    expect(after?.status).toBe('frozen');
    expect(after?.paused).toBe(true);
    expect(after?.paused_at).toBe('2025-01-01T00:00:00.000Z');
    expect(after?.frozen_reason).toBe('operator requested freeze');
    expect(after).toEqual(before);
  });

  it('returns actionable error when analyst pause_runtime has no runtime state', async () => {
    unlinkSync(runtimeStatePath(projectRoot));
    const result = await pause_runtime(ctx(projectRoot, store), {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('runtime state is not initialized');
  });

  it('returns actionable error when analyst resume_runtime has no runtime state', async () => {
    unlinkSync(runtimeStatePath(projectRoot));
    const result = await resume_runtime(ctx(projectRoot, store), {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('runtime state is not initialized');
  });
});

describe('Analyst Handler', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = uniqueDir();
    setupTestProject(projectRoot);
  });
  afterEach(() => {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  });

  it('creates and reuses analyst sessions', () => {
    const first = getOrCreateAnalystSession(projectRoot);
    const second = getOrCreateAnalystSession(projectRoot);
    expect(first.sessionId).toBe('analyst');
    expect(second.session.started_at).toBe(first.session.started_at);
  });

  it('deduplicates the same chat message when two transports submit it together', async () => {
    const handler = new AnalystHandler(projectRoot);
    const first = await handler.handleMessage('s16', 'list all cards');
    const second = await handler.handleMessage('s16', 'list all cards');
    expect(second.message.content).toBe(first.message.content);
  });
});

describe('API Chat and WebSocket Integration', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupTestProject(projectRoot);
    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;
    resetAuthPolicyForTests();

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    const { default: authPlugin } = await import('../src/server/auth.js');
    await app.register(authPlugin);

    const { registerCardRoutes } = await import('../src/server/routes/cards.js');
    const { registerRuntimeConfigNotesRoutes } = await import('../src/server/routes/runtime-config-notes.js');
    const { registerChatsFilesDebugRoutes } = await import('../src/server/routes/chats-files-debug.js');
    const { registerWebSocket } = await import('../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
    registerWebSocket(app, projectRoot);

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }, 10000);

  function apiUrl(path: string): string { return `http://127.0.0.1:${port}${path}`; }
  function wsUrl(): string { const ticket = getAuthPolicy().issueWebSocketTicket().ticket; return `ws://127.0.0.1:${port}/ws?ticket=${ticket}`; }
  function authHdr(): Record<string, string> { return { authorization: `Bearer ${authToken}` }; }

  it('returns a real analyst response message', async () => {
    const res = await fetch(apiUrl('/api/chats/chat-int-1'), { method: 'POST', headers: { ...authHdr(), 'content-type': 'application/json' }, body: JSON.stringify({ content: 'list all cards' }) });
    expect(res.status).toBe(200);
  });

  it('sending a message via WebSocket returns a real analyst response', (done) => {
    const ws = new WebSocket(wsUrl());
    let welcomed = false;
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString()) as { type: string; content: Record<string, unknown> };
      if (!welcomed && data.content.event === 'connected') { welcomed = true; ws.send(JSON.stringify({ type: 'message', content: { text: 'list all cards' } })); return; }
      if (welcomed && data.type === 'message') { expect(data.content.content).toBeTruthy(); ws.close(); done(); }
    });
    ws.on('error', (err) => { ws.close(); done(err); });
  }, 15000);
});
