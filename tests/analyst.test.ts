import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { getAuthPolicy, resetAuthPolicyForTests } from '../src/server/auth-policy.js';
import { existsSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../src/cards/card-store.js';
import { initProjectTree } from '../src/persistence/file-tree.js';
import { materializeProjectCard } from './helpers/materialize-project-card.js';
import { listControlActions } from '../src/persistence/index.js';
import {
  initRuntimeState,
  readRuntimeState,
  runtimeStatePath,
  updateRuntimeState,
} from '../src/runtime/state.js';
import {
  create_card,
  list_cards,
  get_card,
  get_tree,
  edit_card,
  delete_card,
  queue_notification,
  pause_runtime,
  resume_runtime,
  reorder_child,
  abort_goal_subtree,
} from '../src/agents/tool-api.js';
import type { ToolContext } from '../src/tools/analyst-tool-types.js';

const TEST_BRIEF = '# Goal\n\nTest card goal\n\n# Instructions\n\nFollow the test setup.\n\n# Acceptance Criteria\n\nAssertions pass.\n';

import { AnalystHandler, getOrCreateAnalystSession } from '../src/agents/analyst-handler.js';
import {
  ANALYST_TOOL_DEFINITIONS,
  ANALYST_ISSUE_SEVERITY_VALUES,
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  CREATE_CARD_TYPE_VALUES,
  NOTE_KIND_VALUES,
  URGENCY_VALUES,
} from '../src/tools/definitions/index.js';
import { cardStatusSchema, cardTypeSchema, urgencySchema } from '../src/schemas/validators.js';
import {
  createTestAnalystRuntime,
  createTestRuntimeApplication,
} from './helpers/test-runtime-application.js';
import { markGoalNeedsCorrections } from '../src/agents/analyst-stage6.js';
import { createSession } from '../src/runtime/session-persistence.js';
import { getProjectNotificationCenter } from '../src/notifications/notification-delivery.js';

function uniqueDir(): string {
  return join(
    tmpdir(),
    `saivage-analyst-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function setupProject(projectRoot: string): void {
  const sd = join(projectRoot, '.saivage');
  initProjectTree(projectRoot);
  writeFileSync(
    join(sd, 'saivage.json'),
    JSON.stringify({
      server: { port: 8080, host: '127.0.0.1' },
      models: { default: ['test-model'] },
      providers: {},
    }),
  );
  materializeProjectCard(projectRoot);
  initRuntimeState(projectRoot);
}

function setupTestProject(projectRoot: string): CardStore {
  setupProject(projectRoot);
  const store = new CardStore(projectRoot);
  store.create({
    type: 'goal',
    parent: 'project',
    title: 'Test Goal',
    brief: 'A test goal',
    status: 'running',
    depth: 0,
    tags: [],
    priority: 1,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
    related: [],
    retries: 0,
  });
  store.create({
    type: 'code',
    parent: 'card-1',
    title: 'Code Task 1',
    brief: 'Implement feature',
    status: 'backlog',
    depth: 0,
    tags: ['code'],
    priority: 2,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
    related: [],
    retries: 0,
  });
  return store;
}

function ctx(projectRoot: string, store: CardStore): ToolContext {
  return { projectRoot, store, actor: 'analyst', surface: 'web-chat' };
}

describe('Analyst Tool Definitions', () => {
  it('do not advertise removed plan card types', () => {
    const toolNames = ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name);
    expect(toolNames).not.toContain('create_plan');
    expect(toolNames).not.toContain('update_plan');
    expect(toolNames).toContain('create_card');
    expect(toolNames).toContain('delete_card');
    expect(toolNames).toContain('reorder_child');
    expect(toolNames).toContain('cancel_card');
    expect(toolNames).not.toContain('restart_goal');
    expect(toolNames).not.toContain('restart_card_or_subtree');
    expect(toolNames).not.toContain('edit_card');
    expect(toolNames).toContain('queue_notification');
    expect(toolNames).toContain('list_card_history');
  });

  function toolByName(name: string) {
    const definition = ANALYST_TOOL_DEFINITIONS.find((tool) => tool.function.name === name);
    expect(definition).toBeDefined();
    return definition!;
  }

  function propertiesFor(name: string): Record<string, Record<string, unknown>> {
    const parameters = toolByName(name).function.parameters as {
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(parameters.properties).toBeDefined();
    return parameters.properties!;
  }

  it('keeps exported analyst enum vocabularies aligned with runtime validators', () => {
    expect([...CARD_STATUS_VALUES]).toEqual(cardStatusSchema.options);
    expect([...CARD_TYPE_VALUES]).toEqual(cardTypeSchema.options);
    expect([...URGENCY_VALUES]).toEqual(urgencySchema.options);
    expect([...ANALYST_ISSUE_SEVERITY_VALUES]).toEqual(['info', 'warning', 'blocker']);
  });

  it('emits enum JSON schema constraints and guidance for card, list, and notification tools', () => {
    const createProps = propertiesFor('create_card');
    expect(createProps.type.enum).toEqual([...CREATE_CARD_TYPE_VALUES]);
    expect(toolByName('create_card').function.description).toContain('without dispatching work');

    const listProps = propertiesFor('list_cards');
    const listStatus = listProps.status as {
      anyOf?: Array<{ enum?: unknown; items?: { enum?: unknown } }>;
    };
    const listType = listProps.type as {
      anyOf?: Array<{ enum?: unknown; items?: { enum?: unknown } }>;
    };
    expect(listStatus.anyOf?.[0]?.enum).toEqual([...CARD_STATUS_VALUES]);
    expect(listStatus.anyOf?.[1]?.items?.enum).toEqual([...CARD_STATUS_VALUES]);
    expect(listType.anyOf?.[0]?.enum).toEqual([...CARD_TYPE_VALUES]);
    expect(listType.anyOf?.[1]?.items?.enum).toEqual([...CARD_TYPE_VALUES]);
    expect(listProps.status.enum).toBeUndefined();
    expect(listProps.type.enum).toBeUndefined();

    expect(toolByName('queue_notification').function.description).toContain('Queue a notification');
  });

  it('exports valid OpenAI-compatible ToolDefinition objects for LLM clients', () => {
    for (const definition of ANALYST_TOOL_DEFINITIONS) {
      expect(definition.type).toBe('function');
      expect(definition.function.name).toMatch(/^[a-z_]+$/);
      expect(typeof definition.function.description).toBe('string');
      expect(definition.function.description.length).toBeGreaterThan(0);
      expect(definition.function.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
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
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
  });

  it('rejects Analyst child-card creation while unpaused', async () => {
    const r = await create_card(ctx(projectRoot, store), {
      type: 'code',
      parent: 'card-1',
      title: 'New Code Card',
      brief: TEST_BRIEF,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('requires the runtime to be paused');
  });

  it('marks a done goal changed through the analyst correction repair path', () => {
    store.repairTerminalLifecycle('card-1', {
      status: 'done',
      lifecycle: {
        status: 'done',
        result: { kind: 'planner_done', summary: 'accepted' },
        error: null,
        completed_at: new Date().toISOString(),
      },
    });

    const result = markGoalNeedsCorrections(projectRoot, store, 'card-1', [
      { summary: 'needs follow-up' },
    ]);

    expect(result.status_transition).toEqual({ from: 'done', to: 'changed' });
    expect(store.read('card-1')?.status).toBe('changed');
  });

  it('denies analyst subtree abort through explicit card.cancel permission checks', async () => {
    const result = await abort_goal_subtree(ctx(projectRoot, store), { goalId: 'card-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be cancelled by analyst');
    expect(store.read('card-1')?.status).toBe('running');
  });

  it('includes display paths in analyst card projections', async () => {
    const list = await list_cards(ctx(projectRoot, store), {});
    const detail = await get_card(ctx(projectRoot, store), { id: 'card-1' });
    const tree = await get_tree(ctx(projectRoot, store), {});

    expect(list.success).toBe(true);
    expect(list.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'project', display_path: null }),
      expect.objectContaining({ id: 'card-1', display_path: '1' }),
    ]));
    expect(detail.success).toBe(true);
    expect(detail.data).toEqual(expect.objectContaining({ id: 'card-1', display_path: '1' }));
    expect((detail.data as { children: Array<{ id: string; display_path: string | null }> }).children).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'card-2', display_path: '1.1' }),
    ]));
    expect(tree.success).toBe(true);
    expect(tree.data).toEqual(expect.objectContaining({ id: 'project', display_path: null }));
  });

  it('creates the first project card in an empty store', async () => {
    const emptyRoot = uniqueDir();
    initProjectTree(emptyRoot);
    const emptyStore = new CardStore(emptyRoot);

    try {
      const result = await create_card(ctx(emptyRoot, emptyStore), {
        type: 'project',
        parent: null,
        title: 'Project',
        brief: TEST_BRIEF,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({
          id: 'project',
          type: 'project',
          parent: null,
          title: 'Project',
        }),
      );
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('rejects Analyst top-level goal creation in an empty store', async () => {
    const emptyRoot = uniqueDir();
    initProjectTree(emptyRoot);
    const emptyStore = new CardStore(emptyRoot);

    try {
      const result = await create_card(ctx(emptyRoot, emptyStore), {
        type: 'goal',
        parent: 'project',
        title: 'First goal',
        brief: TEST_BRIEF,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires the runtime to be paused');
      expect(emptyStore.read('project')).toBeNull();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('rejects duplicate project card creation', async () => {
    const result = await create_card(ctx(projectRoot, store), {
      type: 'project',
      parent: null,
      title: 'Project',
      brief: TEST_BRIEF,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Root project card already exists');
  });

  it('denies delete_card for matrix-disallowed target states', async () => {
    store.setStatus('card-1', 'running');

    const result = await delete_card(
      { projectRoot, store, actor: 'runtime', surface: 'runtime' },
      { ids: ['card-1'] },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Denied by permission policy');
    expect(store.read('card-1')).not.toBeNull();
  });

  it('denies delete_card when a descendant is matrix-disallowed', async () => {
    store.setStatus('card-1', 'backlog');
    store.setStatus('card-2', 'running');
    store.setStatus('card-2', 'running');

    const result = await delete_card(
      { projectRoot, store, actor: 'runtime', surface: 'runtime' },
      { ids: ['card-1'] },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Denied by permission policy');
    expect(store.read('card-1')).not.toBeNull();
    expect(store.read('card-2')).not.toBeNull();
  });

  it('allows delete_card for a matrix-allowed state', async () => {
    store.update('card-2', { status: 'backlog' });

    const result = await delete_card(
      { projectRoot, store, actor: 'runtime', surface: 'runtime' },
      { ids: ['card-2'] },
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ deleted: ['card-2'], top_level_deleted: ['card-2'] });
    expect(store.read('card-2')).toBeNull();
  });

  it('queues analyst notifications and audits metadata without body content', async () => {
    const result = await queue_notification(ctx(projectRoot, store), {
      recipient: 'card-2',
      kind: 'heads_up',
      body: 'secret notification body',
    });

    expect(result).toEqual({ success: true, data: { queued: true, recipient: 'card-2' } });
    const audits = listControlActions(projectRoot);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: 'analyst',
          surface: 'web-chat',
          action: 'notification.queue',
          target_id: 'card-2',
          outcome: 'ok',
        }),
      ]),
    );
    const audit = audits.find(
      (entry) => entry.action === 'notification.queue' && entry.target_id === 'card-2',
    );
    expect(audit?.params_summary).toContain('heads_up');
    expect(audit?.params_summary).toContain('card-2');
    expect(audit?.outcome_summary).not.toContain('secret notification body');
    expect(audit?.params_summary).not.toContain('secret notification body');
  });

  it('returns unknown_recipient for analyst queue_notification without queueing', async () => {
    const result = await queue_notification(ctx(projectRoot, store), {
      recipient: 'missing-target',
      kind: 'heads_up',
      body: 'body that must not audit',
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      data: { reason: 'unknown_recipient', recipient: 'missing-target' },
      errorEnvelope: expect.objectContaining({ kind: 'not_found' }),
    }));
    const audits = listControlActions(projectRoot);
    const audit = audits.find(
      (entry) => entry.action === 'notification.queue' && entry.target_id === 'missing-target',
    );
    expect(audit).toBeDefined();
    expect(audit?.outcome).toBe('error');
    expect(audit?.outcome_summary).not.toContain('body that must not audit');
    expect(audit?.params_summary).not.toContain('body that must not audit');
  });

  it('rejects broad analyst edit_card calls', async () => {
    createSession(join(projectRoot, '.saivage'), 'executor', 'card-1', 'card-2', undefined, 'executor-session');

    const result = await edit_card(ctx(projectRoot, store), {
      id: 'card-2',
      description: 'Updated objective for this implementation card.',
      acceptance: 'Updated acceptance criteria.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('edit_card is not available to the Analyst');
    expect(getProjectNotificationCenter(projectRoot).drainPendingForSession('executor-session')).toEqual([]);
  });

  it('rejects analyst lifecycle/status edits through unavailable edit_card', async () => {
    const result = await edit_card(ctx(projectRoot, store), { id: 'card-2', status: 'done' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('edit_card is not available to the Analyst');
  });

  it('audits analyst reorder_child with the calling surface', async () => {
    updateRuntimeState(projectRoot, { status: 'paused', paused: true, paused_at: new Date().toISOString() });
    store.setStatus('card-1', 'backlog');
    const childTwo = store.create({
      type: 'code',
      parent: 'card-1',
      title: 'Code Task 2',
      brief: 'Code Task 2',
      status: 'backlog',
      depth: 0,
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
      related: [],
      retries: 0,
    });

    const reorderResult = await reorder_child(ctx(projectRoot, store), {
      parentId: 'card-1',
      orderedChildIds: [childTwo.id, 'card-2'],
    });
    expect(reorderResult.success).toBe(true);

    const audits = listControlActions(projectRoot);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: 'analyst',
          surface: 'web-chat',
          action: 'card.reorder_child',
          target_id: 'card-1',
          outcome: 'ok',
        }),
      ]),
    );
  });

  it('returns actionable enum preflight errors for invalid create_card values', async () => {
    const result = await create_card(ctx(projectRoot, store), {
      type: 'task' as never,
      parent: 'card-1',
      title: 'Bad Card',
      brief: TEST_BRIEF,
      status: 'ready' as never,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("create_card failed: field 'type' received 'task'");
    expect(result.error).toContain(`Allowed values: ${CREATE_CARD_TYPE_VALUES.join(', ')}`);
    expect(result.error).toContain("See the 'create_card' tool's parameter schema");
  });

  it('returns actionable enum preflight errors for invalid edit_card status', async () => {
    const result = await edit_card(
      { projectRoot, store, actor: 'runtime', surface: 'runtime' },
      {
        id: 'card-2',
        status: 'todo',
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("edit_card failed: field 'status' received 'todo'");
    expect(result.error).toContain(`Allowed values: ${CARD_STATUS_VALUES.join(', ')}`);
    expect(result.error).toContain("See the 'edit_card' tool's parameter schema");
  });

  it('returns actionable error when analyst pause_runtime has no runtime state', async () => {
    unlinkSync(runtimeStatePath(projectRoot));
    const result = await pause_runtime(ctx(projectRoot, store), {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  it('returns actionable error when analyst resume_runtime has no runtime state', async () => {
    unlinkSync(runtimeStatePath(projectRoot));
    const result = await resume_runtime(ctx(projectRoot, store), {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });
});

describe('Analyst Handler', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = uniqueDir();
    setupTestProject(projectRoot);
  });
  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
  });

  it('creates and reuses analyst sessions', () => {
    const first = getOrCreateAnalystSession(projectRoot);
    const second = getOrCreateAnalystSession(projectRoot);
    expect(first.sessionId).toBe('analyst');
    expect(second.session.started_at).toBe(first.session.started_at);
  });

  it('deduplicates the same chat message when two transports submit it together', async () => {
    const handler = new AnalystHandler(projectRoot, createTestAnalystRuntime({ cardStore: new CardStore(projectRoot) }));
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

    const { registerCardRoutes } = await import('../src/server/routes/cards.js');
    const { registerChatsFilesDebugRoutes } =
      await import('../src/server/routes/chats-files-debug.js');
    const { registerWebSocket } = await import('../src/server/websocket.js');
    const { LiveSyncSocket } = await import('../src/server/live-sync-socket.js');

    const routeStore = new CardStore(projectRoot);
    registerCardRoutes(app, projectRoot, createTestRuntimeApplication({ cardStore: routeStore }), routeStore);
    registerChatsFilesDebugRoutes(app, projectRoot, routeStore);
    registerWebSocket(app, projectRoot, {
      runtimeApplication: createTestRuntimeApplication({ cardStore: new CardStore(projectRoot) }),
      liveSyncSocket: new LiveSyncSocket(),
      requestServerRestart: async () => undefined,
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    await app.close();
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
  }, 10000);

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }
  function wsUrl(): string {
    const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
    return `ws://127.0.0.1:${port}/ws?ticket=${ticket}`;
  }
  function authHdr(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  it('returns a real analyst response message', async () => {
    const res = await fetch(apiUrl('/api/chats/analyst'), {
      method: 'POST',
      headers: { ...authHdr(), 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'list all cards' }),
    });
    expect(res.status).toBe(200);
  });

  it('sending a message via WebSocket returns a real analyst response', (done) => {
    const ws = new WebSocket(wsUrl());
    let welcomed = false;
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString()) as { type: string; content: Record<string, unknown> };
      if (!welcomed && data.content.event === 'connected') {
        welcomed = true;
        ws.send(JSON.stringify({ type: 'message', content: { text: 'list all cards' } }));
        return;
      }
      if (welcomed && data.type === 'message') {
        expect(data.content.content).toBeTruthy();
        ws.close();
        done();
      }
    });
    ws.on('error', (err) => {
      ws.close();
      done(err);
    });
  }, 15000);
});
