import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { getAuthPolicy, resetAuthPolicyForTests } from '../src/server/auth-policy.js';
import { createServer, type ServerInstance } from '../src/server/server.js';
import { loadEnvironment } from '../src/config/environment.js';
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
  delete_card,
  queue_notification,
  pause_runtime,
  resume_runtime,
  reorder_child,
} from '../src/agents/tool-api.js';
import type { ToolContext } from '../src/tools/analyst-tool-types.js';
import { ProcessRunner } from '../src/runtime/process-runner.js';

const TEST_BRIEF = '# Goal\n\nTest card goal\n\n# Instructions\n\nFollow the test setup.\n\n# Acceptance Criteria\n\nAssertions pass.\n';

import { AnalystRuntime } from '../src/agents/analyst-handler.js';
import { resolveAnalystSessionId } from '../src/agents/session-ids.js';
import { readConversationMessages } from '../src/runtime/actors/conversation-store.js';
import { ANALYST_TOOL_DEFINITIONS } from '../src/tools/analyst-tool-registry.js';
import {
  ANALYST_ISSUE_SEVERITY_VALUES,
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  CREATE_CARD_TYPE_VALUES,
  NOTE_KIND_VALUES,
  URGENCY_VALUES,
} from '../src/tools/tool-definition.js';
import { cardStatusSchema, cardTypeSchema, urgencySchema } from '../src/schemas/validators.js';
import { createTestPromptTemplateRegistry } from './helpers/prompt-template-registry.js';
import {
  createTestAnalystRuntime,
  createTestRuntimeApplication,
  loadTestConfig,
} from './helpers/test-runtime-application.js';

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
    join(sd, 'saivage.yaml'),
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
  return { projectRoot, processRunner: new ProcessRunner(projectRoot), store, actor: 'analyst', surface: 'web-chat' };
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
    expect(toolNames).not.toContain('list_card_history');
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
    jest.restoreAllMocks();
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
  });

  it('rejects Analyst child-card creation under a running parent', async () => {
    const r = await create_card(ctx(projectRoot, store), {
      type: 'code',
      parent: 'card-1',
      title: 'New Code Card',
      brief: TEST_BRIEF,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("parent 'card-1' in status 'running'");
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

  it('rejects Analyst project-card bootstrap because init creates the root', async () => {
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

      expect(result.success).toBe(false);
      expect(result.error).toContain('Root project card already exists');
      expect(emptyStore.read('project')).toEqual(expect.objectContaining({ id: 'project', type: 'project', parent: null }));
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('allows Analyst top-level goal creation in a stopped initialized project', async () => {
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

      expect(result.success).toBe(true);
      expect(emptyStore.read('card-1')).toEqual(expect.objectContaining({ type: 'goal', parent: 'project', title: 'First goal' }));
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
      { projectRoot, processRunner: new ProcessRunner(projectRoot), store, actor: 'runtime', surface: 'runtime' },
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
      { projectRoot, processRunner: new ProcessRunner(projectRoot), store, actor: 'runtime', surface: 'runtime' },
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
      { projectRoot, processRunner: new ProcessRunner(projectRoot), store, actor: 'runtime', surface: 'runtime' },
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
      error: "Unknown notification recipient 'missing-target'.",
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

  it('returns and audits structured analyst queue_notification failure when delivery target card is missing', async () => {
    const runtime = createTestAnalystRuntime({ projectRoot, cardStore: store }).runtime!;
    runtime.notifyCard = () => ({ ok: false as const, reason: 'missing_card' as const, cardId: 'card-2' });

    const result = await queue_notification({ ...ctx(projectRoot, store), runtime }, {
      recipient: 'card-2',
      kind: 'heads_up',
      body: 'body that must not bypass audit',
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      data: expect.objectContaining({ reason: 'missing_card', recipient: 'card-2', cardIds: ['card-2'] }),
      error: 'Notification delivery failed for missing card(s): card-2.',
    }));
    const audit = listControlActions(projectRoot).find(
      (entry) => entry.action === 'notification.queue' && entry.target_id === 'card-2',
    );
    expect(audit).toBeDefined();
    expect(audit?.outcome).toBe('error');
    expect(audit?.outcome_summary).toBe('Notification delivery failed for missing card(s): card-2.');
    expect(audit?.params_summary).not.toContain('body that must not bypass audit');
  });

  it('audits analyst reorder_child with the calling surface', async () => {
    updateRuntimeState(projectRoot, { status: 'paused' });
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

describe('Analyst Runtime', () => {
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

  it('rejects a concurrent second turn for the same analyst session', async () => {
    let resolveProvider!: (result: { result: { kind: 'message'; content: string }; provider_exchanges: [] }) => void;
    const runtimeDeps = createTestAnalystRuntime({ projectRoot, cardStore: new CardStore(projectRoot) });
    runtimeDeps.provider = { completeTurn: async () => new Promise((resolve) => { resolveProvider = resolve; }) };
    const runtime = new AnalystRuntime({ projectRoot, promptTemplates: createTestPromptTemplateRegistry(), config: loadTestConfig(projectRoot), runtimeDeps });
    const first = runtime.submit('s16', { userContent: 'list all cards' });
    await expect(runtime.submit('s16', { userContent: 'list all cards' })).rejects.toThrow('already has an active turn');
    await new Promise((resolve) => setImmediate(resolve));
    resolveProvider({ result: { kind: 'message', content: 'Done.' }, provider_exchanges: [] });
    const response = await first;
    expect(response.sessionId).toBe('analyst:s16');
    expect(response.toolInvocations ?? []).toEqual([]);
    expect(readConversationMessages(projectRoot, response.sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', kind: 'text', content: 'Done.' }),
      ]),
    );
  });
});

describe('API Chat and WebSocket Integration', () => {
  let projectRoot: string;
  let server: ServerInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupTestProject(projectRoot);
    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;
    resetAuthPolicyForTests();

    server = await createServer({ environment: loadEnvironment(['node', 'test', '--project-root', projectRoot], process.env) });
    await server.fastify.listen({ port: 0, host: '127.0.0.1' });
    port = (server.fastify.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    await server.stop();
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
    const res = await fetch(apiUrl('/api/chats/analyst:global'), {
      method: 'POST',
      headers: { ...authHdr(), 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'list all cards' }),
    });
    expect(res.status).toBe(200);
  });

  it('sending a message via WebSocket invalidates the canonical analyst conversation', (done) => {
    const ws = new WebSocket(wsUrl());
    let welcomed = false;
    let settled = false;
    let baselineAssistantEntryIds: Set<string> | null = null;

    type ChatEntry = { id?: unknown; role?: unknown; kind?: unknown; content?: unknown };

    function finish(err?: Error): void {
      if (settled) return;
      settled = true;
      ws.close();
      done(err);
    }

    async function fetchAnalystGlobalEntries(): Promise<ChatEntry[]> {
      const res = await fetch(apiUrl('/api/chats/analyst:global'), { headers: authHdr() });
      if (!res.ok) throw new Error(`GET /api/chats/analyst:global failed with ${res.status}`);
      const body = await res.json() as { entries?: unknown };
      if (!Array.isArray(body.entries)) throw new Error('GET /api/chats/analyst:global returned no entries array');
      return body.entries as ChatEntry[];
    }

    function isAssistantTextEntry(entry: ChatEntry): entry is ChatEntry & { id: string; content: string } {
      return typeof entry.id === 'string'
        && entry.role === 'assistant'
        && entry.kind === 'text'
        && typeof entry.content === 'string'
        && entry.content.trim().length > 0;
    }

    ws.on('message', (raw) => {
      if (settled) return;
      let data: { type?: string; content?: Record<string, unknown>; t?: string; resource?: string; id?: string };
      try {
        data = JSON.parse(raw.toString()) as { type?: string; content?: Record<string, unknown>; t?: string; resource?: string; id?: string };
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!welcomed && data.content?.event === 'connected') {
        welcomed = true;
        ws.send(JSON.stringify({ t: 'subscribe', resource: 'conversation', id: 'analyst:global' }));
        void fetchAnalystGlobalEntries()
          .then((entries) => {
            if (settled) return;
            const assistantEntries = entries.filter(isAssistantTextEntry);
            baselineAssistantEntryIds = new Set(assistantEntries.map((entry) => entry.id));
            ws.send(JSON.stringify({ type: 'message', content: { text: 'list all cards' } }));
          })
          .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
        return;
      }

      if (welcomed && data.t === 'invalidate' && data.resource === 'conversation' && data.id === 'analyst:global') {
        if (!baselineAssistantEntryIds) return;
        const baseline = baselineAssistantEntryIds;
        void fetchAnalystGlobalEntries()
          .then((entries) => {
            if (settled) return;
            const hasNewAssistantText = entries
              .filter(isAssistantTextEntry)
              .some((entry) => !baseline.has(entry.id));
            if (hasNewAssistantText) finish();
          })
          .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
      }
    });
    ws.on('error', (err) => {
      finish(err);
    });
  }, 15000);
});
