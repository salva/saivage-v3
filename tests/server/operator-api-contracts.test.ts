import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../src/cards/card-store.js';
import { ServerAvailabilitySchema, operatorApiContracts, operatorRouteInventory, parseOperatorResponse, runtimeCardsOperatorApiContracts } from '../../src/contracts/operator-api.js';
import { LiveSyncClientFrameSchema, LiveSyncInvalidateFrameSchema } from '../../src/contracts/operator-events.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { registerInternalDebugRoutes } from '../../src/server/routes/chats-files-debug.js';

const runtimeState = {
  status: 'stopped',
  project_id: 'project',
  started_at: '2026-01-01T00:00:00.000Z',
  active_card_run: null,
  updated_at: '2026-01-01T00:00:01.000Z',
  runtime_commands: [],
  runtime_runs: [],
  runtime_activations: [],
  pid: 123,
};


const serverAvailability = {
  generatedAt: '2026-01-01T00:00:02.000Z',
  components: {
    api: { state: 'available', source: 'health-check', checkedAt: '2026-01-01T00:00:02.000Z' },
    runtime: { state: 'available', source: 'runtime-application', checkedAt: '2026-01-01T00:00:02.000Z' },
    mcp: { state: 'idle', source: 'mcp-manager', checkedAt: '2026-01-01T00:00:02.000Z', diagnostic: { code: 'mcp-manager-empty', summary: 'No MCP servers configured.' } },
  },
};


const runtimeCommand = {
  command_id: 'cmd-1',
  command: 'start_project',
  status: 'completed',
  requested_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  source: 'operator',
  error: null,
};

const runtimeRun = {
  run_id: 'run-1',
  kind: 'root',
  ownership: { kind: 'direct', source: 'project_root' }, card_id: 'project',
  command_id: 'cmd-1',
  activation_id: null,
  parent_run_id: null,
  phase: 'planner',
  runtime_status: 'running',
  session_id: 'planner:project',
  started_at: '2026-01-01T00:00:01.000Z',
  updated_at: '2026-01-01T00:00:01.000Z',
  finished_at: null,
  outcome: null,
};

const card = {
  id: 'card-1',
  display_path: '1',
  type: 'code',
  parent: null,
  depth: 0,
  title: 'Card 1',
  status: 'backlog',
  subtype: null,
  tags: [],
  priority: 0,
  position: 0,
  urgency: 'normal',
  created_by: 'user',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  version_seq: 1,
  assigned_to: null,
  depends_on: [],
  related: [],
  lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
  operator_summary: { lifecycleStatus: 'backlog', terminal: false, needsVerification: false, blocked: false, hasError: false, error: null, completedAt: null, stale: false, actionCount: 0 },
  metrics: null,
  estimate: null,
  started_at: null,
  duration_ms: null,
  retries: 0,
};

describe('operator API contract registry', () => {
  it('contains the bounded first-batch operation inventory', () => {
    expect(Object.keys(operatorApiContracts)).toEqual([
      'auth.wsTicket',
      'health.liveness',
      'health.readiness',
      'runtime.getState',
      'cards.list',
      'cards.get',
      'cards.history.list',
      'cards.history.get',
      'cards.diff',
      'runtime.status',
      'runtime.cardRuns',
      'mcp.status',
      'mcp.tools',
      'agents.list',
      'agents.detail',
      'agents.conversation',
      'agents.llmExchange',
      'chats.list',
      'chats.get',
      'chats.send',
      'files.list',
      'files.content',
      'debug.state',
      'debug.errors',
      'debug.timeline',
      'processes.list',
      'processes.get',
      'events.list',
      'config.get',
      'providers.list',
      'controlActions.list',
    ]);
    expect(Object.keys(runtimeCardsOperatorApiContracts)).toEqual([
      'health.liveness',
      'health.readiness',
      'runtime.getState',
      'cards.list',
      'cards.get',
      'cards.history.list',
      'cards.history.get',
      'cards.diff',
      'runtime.status',
      'runtime.cardRuns',
    ]);
    expect(operatorRouteInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'auth.wsTicket', method: 'POST', path: '/api/auth/ws-ticket', requiresAuth: true, successSchemaName: 'WebSocketTicketResponse' }),
      expect.objectContaining({ operationId: 'health.liveness', method: 'GET', path: '/health', successSchemaName: 'HealthLivenessResponse' }),
      expect.objectContaining({ operationId: 'health.readiness', method: 'GET', path: '/health/ready', successSchemaName: 'HealthReadinessResponse' }),
      expect.objectContaining({ operationId: 'runtime.status', method: 'GET', path: '/api/runtime/status', successSchemaName: 'RuntimeStatusResponse' }),
      expect.objectContaining({ operationId: 'mcp.status', method: 'GET', path: '/api/mcp/status', successSchemaName: 'McpStatusResponse' }),
      expect.objectContaining({ operationId: 'agents.list', method: 'GET', path: '/api/agents', successSchemaName: 'AgentListResponse' }),
      expect.objectContaining({ operationId: 'agents.detail', method: 'GET', path: '/api/agents/:id', successSchemaName: 'AgentDetailResponse' }),
      expect.objectContaining({ operationId: 'agents.conversation', method: 'GET', path: '/api/agents/:id/conversation', successSchemaName: 'AgentConversationResponse' }),
      expect.objectContaining({ operationId: 'agents.llmExchange', method: 'GET', path: '/api/agents/:id/llm-exchange', successSchemaName: 'AgentLlmExchangeResponse' }),
      expect.objectContaining({ operationId: 'chats.send', method: 'POST', path: '/api/chats/:sessionId', successSchemaName: 'ChatSendResponse' }),
      expect.objectContaining({ operationId: 'files.content', method: 'GET', path: '/api/files/content', successSchemaName: 'WorkspaceFileContentResponse' }),
      expect.objectContaining({ operationId: 'debug.timeline', method: 'GET', path: '/api/debug/timeline', successSchemaName: 'DebugTimelineResponse' }),
      expect.objectContaining({ operationId: 'processes.list', method: 'GET', path: '/api/processes', successSchemaName: 'ProcessListResponse' }),
      expect.objectContaining({ operationId: 'processes.get', method: 'GET', path: '/api/processes/:id', successSchemaName: 'ProcessDetailResponse' }),
      expect.objectContaining({ operationId: 'events.list', method: 'GET', path: '/api/events', successSchemaName: 'EventsListResponse' }),
      expect.objectContaining({ operationId: 'config.get', method: 'GET', path: '/api/config', successSchemaName: 'ConfigGetResponse' }),
      expect.objectContaining({ operationId: 'providers.list', method: 'GET', path: '/api/providers', successSchemaName: 'ProvidersListResponse' }),
      expect.objectContaining({ operationId: 'controlActions.list', method: 'GET', path: '/api/control-actions', successSchemaName: 'ControlActionsListResponse' }),
    ]));
  });

  it('parses first-batch success examples', () => {
    expect(parseOperatorResponse('runtime.getState', { projectRoot: '/work/test', projectId: 'test', runtime: runtimeState, cardIndex: { total: 1, byStatus: { backlog: 1 }, byType: { code: 1 } } }).runtime).toEqual(runtimeState);
    expect(parseOperatorResponse('runtime.getState', { projectRoot: '/work/test', projectId: 'test', runtime: runtimeState, cardIndex: { total: 1, byStatus: { backlog: 1 }, byType: { code: 1 } }, serverAvailability }).serverAvailability?.components.mcp.state).toBe('idle');
    expect(parseOperatorResponse('runtime.status', {
      runtime: 'running',
      currentCardId: 'card-1',
      goalCount: 1,
      lastTickAt: null,
      pid: 123,
      lastCommand: runtimeCommand,
      activeRun: runtimeRun,
      latestRun: runtimeRun,
      actorRuntime: {
        pauseMode: 'running',
        activeWork: 'model_invocation',
        cards: [{ cardId: 'card-1', actorState: 'running' }],
        agents: [{ agentId: 'planner:card-1', role: 'planner', cardId: 'card-1', phase: 'waiting_for_tool' }],
        diagnostics: [],
        recovery: null,
      },
    }).actorRuntime.agents[0]).toEqual({ agentId: 'planner:card-1', role: 'planner', cardId: 'card-1', phase: 'waiting_for_tool' });
    expect(parseOperatorResponse('cards.list', { cards: [card], total: 1 }).total).toBe(1);
    expect(parseOperatorResponse('cards.get', { card: { ...card, dependencyRefs: [], relatedRefs: [] }, children: [], ancestorIds: [], ancestorRefs: [] }).card.id).toBe('card-1');
    const chatSend = parseOperatorResponse('chats.send', {
      sessionId: 'analyst:global',
      message: { id: 'm1', role: 'assistant', kind: 'text', content: 'hello', timestamp: '2026-01-01T00:00:03.000Z' },
      toolInvocations: [],
    });
    expect(chatSend.message.role).toBe('assistant');
    expect(chatSend.toolInvocations).toEqual([]);
  });



  it('rejects malformed server availability component states', () => {
    expect(ServerAvailabilitySchema.parse(serverAvailability).components.api.state).toBe('available');
    expect(() => parseOperatorResponse('runtime.getState', {
      projectRoot: '/work/test',
      projectId: 'test',
      runtime: runtimeState,
      cardIndex: { total: 0, byStatus: {}, byType: {} },
      serverAvailability: { ...serverAvailability, components: { ...serverAvailability.components, runtime: { ...serverAvailability.components.runtime, state: 'failed' } } },
    })).toThrow();
  });

  it('rejects legacy runtime status and unknown actor vocabulary', () => {
    const response = {
      runtime: 'running',
      currentCardId: 'card-1',
      goalCount: 1,
      lastTickAt: null,
      pid: 123,
      lastCommand: runtimeCommand,
      activeRun: runtimeRun,
      latestRun: runtimeRun,
      actorRuntime: {
        pauseMode: 'running',
        activeWork: 'none',
        cards: [{ cardId: 'card-1', actorState: 'running' }],
        agents: [{ agentId: 'planner:card-1', role: 'planner', cardId: 'card-1', phase: 'idle' }],
        diagnostics: [],
        recovery: null,
      },
    };

    expect(() => parseOperatorResponse('runtime.status', { ...response, runtime: 'unknown' })).toThrow();
    expect(() => parseOperatorResponse('runtime.status', { ...response, actorRuntime: { ...response.actorRuntime, cards: [{ cardId: 'card-1', actorState: 'unknown' }] } })).toThrow();
    expect(() => parseOperatorResponse('runtime.status', { ...response, actorRuntime: { ...response.actorRuntime, agents: [{ agentId: 'planner:card-1', role: 'planner', cardId: 'card-1', phase: 'waiting_tool' }] } })).toThrow();
  });

  it('rejects malformed migrated responses', () => {
    expect(() => parseOperatorResponse('cards.list', { cards: [{}], total: 1 })).toThrow();
  });


  it('validates events list response and legacy failure contracts', () => {
    const event = { id: 'evt-started', kind: 'runtime_diagnostic', timestamp: '2026-01-01T00:00:00.000Z', error_message: 'started' };
    expect(parseOperatorResponse('events.list', { events: [event], total: 1 }).events[0].id).toBe('evt-started');
    expect(() => parseOperatorResponse('events.list', { events: [{}], total: 1 })).toThrow();
    expect(operatorApiContracts['events.list'].response?.[500]?.parse({ error: 'Failed to query events', message: 'boom' })).toEqual({ error: 'Failed to query events', message: 'boom' });
    expect(() => operatorApiContracts['events.list'].response?.[500]?.parse({ error: 'InternalServerError', message: 'boom' })).toThrow();
  });

  it('validates process list and detail response contracts', () => {
    const process = {
      id: 'proc-1',
      status: 'running',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      exit_code: null,
      timed_out: false,
      owner: 'agent',
      owner_id: 'planner-1',
      session_id: 'planner-1',
      card_id: 'card-1',
      command: 'npm test',
      cwd: '.',
      logs: { stdout: 'stdout.log', stderr: null, combined: 'combined.log' },
    };
    expect(parseOperatorResponse('processes.list', { processes: [process] }).processes[0].id).toBe('proc-1');
    expect(parseOperatorResponse('processes.get', { process }).process.card_id).toBe('card-1');
    expect(() => parseOperatorResponse('processes.list', { processes: [{ ...process, logs: { stdout: 1, stderr: null, combined: null } }] })).toThrow();
  });



  it('uses sessions for the agent list response contract and inventory', () => {
    const route = operatorRouteInventory().find((item) => item.operationId === 'agents.list');
    expect(route).toEqual(expect.objectContaining({
      operationId: 'agents.list',
      method: 'GET',
      path: '/api/agents',
      requiresAuth: true,
      successSchemaName: 'AgentListResponse',
    }));
    const parsed = parseOperatorResponse('agents.list', {
      sessions: [{ id: 'planner-1', role: 'planner', status: 'active', started_at: '2026-01-01T00:00:00.000Z' }],
    });
    expect(parsed.sessions[0].id).toBe('planner-1');
    expect(() => parseOperatorResponse('agents.list', { sessions: [{}] })).toThrow();
  });


  it('uses a precise agent detail response contract and inventory', () => {
    const route = operatorRouteInventory().find((item) => item.operationId === 'agents.detail');
    expect(route).toEqual(expect.objectContaining({
      operationId: 'agents.detail',
      method: 'GET',
      path: '/api/agents/:id',
      requiresAuth: true,
      successSchemaName: 'AgentDetailResponse',
    }));
    expect(operatorApiContracts['agents.detail'].params?.parse({ id: 'planner-1' })).toEqual({ id: 'planner-1' });
    const parsed = parseOperatorResponse('agents.detail', {
      session: {
        id: 'planner-1',
        role: 'planner',
        status: 'active',
        started_at: '2026-01-01T00:00:00.000Z',
        message_count: 2,
        last_activity_at: '2026-01-01T00:00:02.000Z',
      },
    });
    expect(parsed.session.message_count).toBe(2);
    expect(parsed.session.last_activity_at).toBe('2026-01-01T00:00:02.000Z');
    expect(parsed).not.toHaveProperty('messages');
    expect(() => parseOperatorResponse('agents.detail', {
      session: { id: 'planner-1', role: 'planner', status: 'active', started_at: '2026-01-01T00:00:00.000Z' },
    })).toThrow();
    expect(() => parseOperatorResponse('agents.detail', {
      session: {
        id: 'planner-1',
        role: 'planner',
        status: 'active',
        started_at: '2026-01-01T00:00:00.000Z',
        message_count: 2,
        last_activity_at: 42,
      },
    })).toThrow();
  });

  it('uses entries for the agent conversation response contract and inventory', () => {
    const route = operatorRouteInventory().find((item) => item.operationId === 'agents.conversation');
    expect(route).toEqual(expect.objectContaining({
      operationId: 'agents.conversation',
      method: 'GET',
      path: '/api/agents/:id/conversation',
      requiresAuth: true,
      successSchemaName: 'AgentConversationResponse',
    }));
    expect(operatorApiContracts['agents.conversation'].params?.parse({ id: 'planner-1' })).toEqual({ id: 'planner-1' });
    const parsed = parseOperatorResponse('agents.conversation', {
      session: { id: 'planner-1', role: 'planner', status: 'active', started_at: '2026-01-01T00:00:00.000Z' },
      entries: [{
        id: 'msg-1',
        session_id: 'planner-1',
        role: 'assistant',
        kind: 'text',
        content: 'hello',
        round_id: 'r-assistant-00000000000000000000000000000001',
        message_index: 0,
        block_index: 0,
        timestamp: '2026-01-01T00:00:01.000Z',
      }],
      activity_status: { status: 'idle', pending_calls: [], updated_at: '2026-01-01T00:00:02.000Z' },
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed).not.toHaveProperty('messages');
    expect(() => parseOperatorResponse('agents.conversation', {
      session: { id: 'planner-1', role: 'planner', status: 'active', started_at: '2026-01-01T00:00:00.000Z' },
      messages: [],
      activity_status: { status: 'idle', pending_calls: [], updated_at: '2026-01-01T00:00:02.000Z' },
    })).toThrow();
  });


  it('uses the llm exchange response contract and inventory', () => {
    const route = operatorRouteInventory().find((item) => item.operationId === 'agents.llmExchange');
    expect(route).toEqual(expect.objectContaining({
      operationId: 'agents.llmExchange',
      method: 'GET',
      path: '/api/agents/:id/llm-exchange',
      requiresAuth: true,
      successSchemaName: 'AgentLlmExchangeResponse',
    }));
    expect(operatorApiContracts['agents.llmExchange'].params?.parse({ id: 'planner-1' })).toEqual({ id: 'planner-1' });
    const parsed = parseOperatorResponse('agents.llmExchange', {
      exchange: {
        sessionId: 'planner-1',
        contract_id: 'planner.v1',
        contractName: 'planner',
        capturedAt: '2026-01-01T00:00:00.000Z',
        transport: 'generic',
        candidate: { provider: 'test-provider', model: 'test-model' },
        attempts: [{
          attempt: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:01.000Z',
          status: 'ok',
          terminalToolOffered: [],
          terminalToolFired: null,
          request: { endpoint: 'https://example.test/v1/chat', method: 'POST', headers: {}, body: { prompt: 'hi' } },
          response: { status: 200, headers: {}, bodyRaw: '{"ok":true}', bodyParsed: { ok: true } },
        }],
      },
    });
    expect(parsed.exchange.sessionId).toBe('planner-1');
    expect(() => parseOperatorResponse('agents.llmExchange', { exchange: { sessionId: 'planner-1' } })).toThrow();
    expect(() => parseOperatorResponse('agents.llmExchange', { llm_exchange: parsed.exchange })).toThrow();
  });

  it('uses entries for the analyst chat-history response contract', () => {
    expect(parseOperatorResponse('chats.get', { sessionId: 'analyst:global', entries: [] }).entries).toEqual([]);
    expect(() => parseOperatorResponse('chats.get', { sessionId: 'analyst:global', messages: [] })).toThrow();
  });




  it('validates precise MCP tool response contracts', () => {
    const parsed = parseOperatorResponse('mcp.tools', {
      tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
      servers: ['filesystem'],
      invocationStats: { 'filesystem:read': { total: 1, success: 1, error: 0 } },
      serverDetails: [{
        name: 'filesystem',
        transport: 'stdio',
        status: 'running',
        toolCount: 1,
        tools: [{ name: 'read', inputSchema: { type: 'object' }, stats: { total: 1, success: 1, error: 0 } }],
      }],
    });
    expect(parsed.tools[0].name).toBe('read');
    expect(parsed.tools[0].inputSchema.type).toBe('object');

    expect(() => parseOperatorResponse('mcp.tools', {
      tools: [{ inputSchema: { type: 'object' } }],
      servers: [],
      invocationStats: {},
      serverDetails: [],
    })).toThrow();
    expect(() => parseOperatorResponse('mcp.tools', {
      tools: [{ name: 'bad', inputSchema: { type: 'string' } }],
      servers: [],
      invocationStats: {},
      serverDetails: [],
    })).toThrow();
  });

  it('accepts needs_verification in runtime run and activation contract fields', () => {
    const runWithVerification = { ...runtimeRun, phase: 'needs_verification', outcome: { kind: 'paused', reason: 'needs_verification', detail: 'verification needed' } };
    const activationWithVerification = {
      activation_id: 'act-needs-verification',
      idempotency_key: 'run-1:planner:project:call-2:card-2',
      parent_card_id: 'project',
      parent_run_id: 'run-1',
      parent_session_id: 'planner:project',
      parent_tool_call_id: 'call-2',
      child_card_id: 'card-2',
      status: 'needs_verification',
      requested_at: '2026-01-01T00:00:02.000Z',
      updated_at: '2026-01-01T00:00:02.000Z',
      precondition: 'accepted',
      runtime_run_id: 'run-child-2',
      error: null,
    };
    const parsed = parseOperatorResponse('runtime.getState', {
      projectRoot: '/work/test',
      projectId: 'test',
      runtime: {
        ...runtimeState,
        runtime_runs: [runWithVerification],
        runtime_activations: [activationWithVerification],
      },
      cardIndex: { total: 0, byStatus: {}, byType: {} },
    });
    expect(parsed.runtime?.runtime_runs?.[0]?.phase).toBe('needs_verification');
    expect(parsed.runtime?.runtime_activations?.[0]?.status).toBe('needs_verification');
  });

  it('keeps isolated internal diagnostics out of the operator contract inventory', () => {
    const contractPaths = operatorRouteInventory().map((route) => route.path);
    expect(contractPaths).not.toContain('/api/debug/doctor');
    expect(contractPaths).not.toContain('/api/debug/supervision');
    expect(contractPaths).not.toContain('/api/debug/runtime/start');
  });

  it('registers isolated internal diagnostics as server routes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-internal-debug-routes-'));
    const fastify = Fastify();
    try {
      initProjectTree(root);
      const runtimeApplication = {
        runtimeApi: {
          startProject: async () => ({ success: true, command: runtimeCommand, run: runtimeRun }),
        },
      } as any;
      registerInternalDebugRoutes(fastify, root, new CardStore(root), runtimeApplication);
      await fastify.ready();
      await expect(fastify.inject({ method: 'GET', url: '/api/debug/doctor' })).resolves.toMatchObject({ statusCode: 200 });
      await expect(fastify.inject({ method: 'GET', url: '/api/debug/supervision' })).resolves.toMatchObject({ statusCode: 200 });
      await expect(fastify.inject({ method: 'POST', url: '/api/debug/runtime/start' })).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      await fastify.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not register obsolete lets_dance or preview-hash runtime controls', () => {
    const paths = operatorRouteInventory().map((route) => route.path);
    expect(paths).not.toContain('/api/runtime/start_project');
    expect(paths).not.toContain('/api/runtime/stop_project');
    expect(paths).not.toContain('/api/runtime/lets_dance');
    const retiredTokens = ['\\x70review_\\x68ash', '\\x63onfirmed'];
    expect(JSON.stringify(operatorApiContracts)).not.toMatch(new RegExp(retiredTokens.join('|')));
  });


  it('validates live-sync websocket frames', () => {
    expect(LiveSyncInvalidateFrameSchema.parse({ t: 'invalidate', resource: 'cards' })).toEqual({ t: 'invalidate', resource: 'cards' });
    expect(LiveSyncInvalidateFrameSchema.parse({ t: 'invalidate', resource: 'conversation', id: 'planner:g1' })).toEqual({ t: 'invalidate', resource: 'conversation', id: 'planner:g1' });
    expect(LiveSyncClientFrameSchema.parse({ t: 'subscribe', resource: 'conversation', id: 'planner:g1' })).toEqual({ t: 'subscribe', resource: 'conversation', id: 'planner:g1' });
    expect(LiveSyncClientFrameSchema.parse({ t: 'unsubscribe', resource: 'conversation', id: 'planner:g1' })).toEqual({ t: 'unsubscribe', resource: 'conversation', id: 'planner:g1' });
    expect(() => LiveSyncInvalidateFrameSchema.parse({ t: 'invalidate', resource: 'conversation' })).toThrow();
    expect(() => LiveSyncInvalidateFrameSchema.parse({ t: 'invalidate', resource: 'unknown' })).toThrow();
  });
});
