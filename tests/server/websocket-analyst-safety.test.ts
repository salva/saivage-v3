import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';
import { RuntimeRunEventSchema, parseKnownWsEnvelope } from '../../src/contracts/operator-events.js';
import { createTestRuntimeApplication } from '../helpers/test-runtime-application.js';

const mockGetOrCreateAnalystSession = jest.fn();
const mockGetAnalystHandler = jest.fn();
const mockResetAnalystHandlerCache = jest.fn();

jest.unstable_mockModule('../../src/agents/analyst-handler.js', () => ({
  AnalystHandler: jest.fn(),
  GLOBAL_ANALYST_SESSION_ID: 'analyst',
  getOrCreateAnalystSession: mockGetOrCreateAnalystSession,
  getAnalystHandler: mockGetAnalystHandler,
  resetAnalystHandlerCache: mockResetAnalystHandlerCache,
}));

const authPolicyModule = await import('../../src/server/auth-policy.js');
const { configureAuthPolicy, getAuthPolicy, resetAuthPolicyForTests } = authPolicyModule;
const websocketModule = await import('../../src/server/websocket.js');
const {
  broadcast,
  wireRuntimeEvents,
  createRuntimeEnvelope,
  registerWebSocket,
  resetWebSocketState,
  sendRuntimeStateSnapshotToClient,
} = websocketModule;

function createSocket() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const ws = {
    OPEN: 1,
    CONNECTING: 0,
    readyState: 1,
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler);
      return ws;
    }),
    removeAllListeners: jest.fn(),
  } as unknown as WebSocket;
  return { ws, handlers };
}

function createRoute() {
  const route = { handler: undefined as any };
  const fastify = { addHook: jest.fn(), get: jest.fn((_path, _opts, handler) => { route.handler = handler; }) } as any;
  return { route, fastify };
}

describe('websocket analyst safety', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetOrCreateAnalystSession.mockReturnValue({ sessionId: 'session-1' });
    resetWebSocketState();
    delete process.env.SAIVAGE_API_TOKEN;
    resetAuthPolicyForTests();
  });

  it('websocket fanout projection bounds and redacts analyst tool summaries', async () => {
    const { ws } = createSocket();
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    route.handler(ws, { headers: {}, query: {} });

    const { EventBus } = await import('../../src/events/bus.js');
    const eventBus = new EventBus();
    wireRuntimeEvents({ subscribe: eventBus.subscribe.bind(eventBus) });
    const longSummary = `${'a'.repeat(210)} apiKey=secret-123 .saivage/auth-profiles.json`;
    eventBus.emit('analyst_tool_invoked', { sessionId: 's1', tool: 'run_shell_command', success: true, summary: longSummary, classified_as: 'destructive' });

    const payload = JSON.parse((ws.send as jest.Mock).mock.calls.at(-1)?.[0] as string);
    expect(payload.content.summary.length).toBeLessThanOrEqual(200);
    expect(payload.content.summary).not.toMatch(/secret-123|auth-profiles\.json/i);
    expect(payload.content.summary).toContain('[SECRET_PATH]');
  });

  it('broadcast only reaches authenticated websocket clients', () => {
    configureAuthPolicy({ apiToken: 'top-secret' });
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());

    const authorized = createSocket();
    const unauthorized = createSocket();
    const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
    route.handler(authorized.ws, { headers: {}, query: { ticket } });
    route.handler(unauthorized.ws, { headers: {}, query: {} });

    broadcast({ type: 'activity', content: { event: 'ping' } });

    expect(authorized.ws.send).toHaveBeenCalled();
    expect(unauthorized.ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect((unauthorized.ws.send as jest.Mock).mock.calls.some((call) => String(call[0]).includes('ping'))).toBe(false);
  });



  it('accepts a valid one-use websocket ticket and sends connected status', () => {
    configureAuthPolicy({ apiToken: 'arch004-test-token' });
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
    const { ws } = createSocket();

    route.handler(ws, { headers: {}, query: { ticket } });

    expect(ws.close).not.toHaveBeenCalled();
    const status = JSON.parse((ws.send as jest.Mock).mock.calls[0]?.[0] as string);
    expect(status).toMatchObject({ type: 'status', content: { event: 'connected', sessionId: 'session-1' } });
  });

  it('sends a validated runtime-state snapshot after connected status for authenticated clients', () => {
    const runtimeApplication = {
      runtime: {},
    } as any;
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', runtimeApplication);
    const { ws } = createSocket();

    route.handler(ws, { headers: {}, query: {} });

    const sent = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(sent[0]).toMatchObject({ type: 'status', content: { event: 'connected', sessionId: 'session-1' } });
    expect(sent[1]).toEqual({
      type: 'status',
      content: { event: 'runtime-state' },
    });

    expect(JSON.stringify(sent[1])).not.toContain('synthetic-secret');
  });

  it('sends a valid runtime-state snapshot without CardStore health when no active runtime exists', () => {
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    const { ws } = createSocket();

    route.handler(ws, { headers: {}, query: {} });

    const sent = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(sent[0].content.event).toBe('connected');
    expect(sent[1]).toEqual({ type: 'status', content: { event: 'runtime-state' } });
  });

  it('rejects /ws token query, missing, invalid, and reused tickets with generic 1008 close reason', () => {
    configureAuthPolicy({ apiToken: 'arch004-test-token' });
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());

    const tokenSocket = createSocket();
    route.handler(tokenSocket.ws, { headers: {}, query: { token: 'arch004-test-token' } });
    expect(tokenSocket.ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');

    const missingSocket = createSocket();
    route.handler(missingSocket.ws, { headers: {}, query: {} });
    expect(missingSocket.ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');

    const invalidSocket = createSocket();
    route.handler(invalidSocket.ws, { headers: {}, query: { ticket: 'arch004-ticket-invalid' } });
    expect(invalidSocket.ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');

    const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
    const firstUse = createSocket();
    route.handler(firstUse.ws, { headers: {}, query: { ticket } });
    const secondUse = createSocket();
    route.handler(secondUse.ws, { headers: {}, query: { ticket } });
    expect(secondUse.ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');

    for (const socket of [tokenSocket, missingSocket, invalidSocket, secondUse]) {
      const reason = (socket.ws.close as jest.Mock).mock.calls[0]?.[1] as string;
      expect(reason).not.toMatch(/arch004-test-token|arch004-ticket-invalid/);
    }
  });

  it('rejects expired websocket tickets with generic 1008 close reason', async () => {
    configureAuthPolicy({ apiToken: 'arch004-test-token' });
    jest.useFakeTimers();
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
    jest.advanceTimersByTime(31_000);
    const { ws } = createSocket();

    route.handler(ws, { headers: {}, query: { ticket } });

    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect((ws.close as jest.Mock).mock.calls[0]?.[1]).not.toContain(ticket);
    jest.useRealTimers();
  });

  it('sanitizes direct tool_invocation params and result payloads', async () => {
    const { ws, handlers } = createSocket();
    const { route, fastify } = createRoute();
    mockGetAnalystHandler.mockReturnValue({
      handleMessage: jest.fn(async () => ({
        message: { id: 'm1', role: 'assistant', kind: 'text', content: 'ok', timestamp: new Date().toISOString() },
        toolInvocations: [{
          tool: 'run_shell_command',
          params: { command: 'cat .saivage/auth-profiles.json apiKey=secret-123' },
          result: {
            success: false,
            error: 'apiKey=secret-456 .env',
            data: {
              classified_as: 'destructive',
              stdout: 'token=secret-789',
              stderr: '.saivage/auth-profiles.json',
              command: 'cat .saivage/auth-profiles.json',
              cwd: '/tmp/project',
            },
          },
        }],
      })),
    });
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    route.handler(ws, { headers: {}, query: {} });

    await handlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'message', content: { text: 'inspect secrets' } })));

    const sent = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string));
    const invocation = sent.find((entry) => entry.type === 'activity' && entry.content.event === 'tool_invocation');
    expect(invocation).toBeTruthy();
    const text = JSON.stringify(invocation);
    expect(text).not.toMatch(/secret-123|secret-456|secret-789|auth-profiles\.json|\.env/);
    expect(text).toContain('[SECRET_PATH]');
  });


  it('routes malformed inbound analyst messages through the sanitized error envelope path', async () => {
    const { ws, handlers } = createSocket();
    const { route, fastify } = createRoute();
    mockGetAnalystHandler.mockReturnValue({ handleMessage: jest.fn() });
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    route.handler(ws, { headers: {}, query: {} });

    await handlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'message', content: {} })));

    const sent = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string));
    const error = sent.find((entry) => entry.type === 'error');
    expect(error).toMatchObject({ type: 'error', content: { error: 'Failed to process message' } });
    expect(JSON.stringify(error)).not.toMatch(/auth-profiles|top-secret|apiKey/i);
  });

  it('validates activity fanout through the shared registry', async () => {
    const { ws } = createSocket();
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    route.handler(ws, { headers: {}, query: {} });

    const { EventBus } = await import('../../src/events/bus.js');
    const eventBus = new EventBus();
    wireRuntimeEvents({ subscribe: eventBus.subscribe.bind(eventBus) });
    eventBus.emit('card_history_appended', { entry_id: '00000000-0000-4000-8000-000000000001', entry_kind: 'status', card_id: 'card-1', version_seq: 2, changed_fields: ['status'], changed_at: '2025-01-01T00:00:00.000Z' });

    const payload = JSON.parse((ws.send as jest.Mock).mock.calls.at(-1)?.[0] as string);
    expect(payload).toEqual({ type: 'activity', content: { event: 'card_history_appended', entry_id: '00000000-0000-4000-8000-000000000001', entry_kind: 'status', card_id: 'card-1', version_seq: 2, changed_fields: ['status'], changed_at: '2025-01-01T00:00:00.000Z' } });
  });

  it('serializes rapid same-socket analyst messages and emits assistant replies in input order', async () => {
    const { ws, handlers } = createSocket();
    const { route, fastify } = createRoute();
    let releaseFirst!: () => void;
    const firstDeferred = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handleMessage = jest.fn(async (_sessionId: string, text: string) => {
      if (text === 'first') {
        await firstDeferred;
      }
      return {
        message: {
          id: `reply-${text}`,
          role: 'assistant',
          kind: 'text',
          content: `response ${text}`,
          timestamp: new Date().toISOString(),
        },
      };
    });
    mockGetAnalystHandler.mockReturnValue({ handleMessage });
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    route.handler(ws, { headers: {}, query: {} });

    const firstTurn = handlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'message', content: { text: 'first' } })));
    const secondTurn = handlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'message', content: { text: 'second' } })));
    await new Promise((resolve) => setImmediate(resolve));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenNthCalledWith(1, 'session-1', 'first');
    expect((ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string)).filter((entry) => entry.type === 'message')).toHaveLength(0);

    releaseFirst();
    await firstTurn;
    await secondTurn;

    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage).toHaveBeenNthCalledWith(2, 'session-1', 'second');
    const messageFrames = (ws.send as jest.Mock).mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .filter((entry) => entry.type === 'message');
    expect(messageFrames.map((entry) => entry.content.id)).toEqual(['reply-first', 'reply-second']);
  });


  it('sanitizes analyst activity broadcasts from handler callbacks end-to-end', async () => {
    const { ws, handlers } = createSocket();
    const { route, fastify } = createRoute();
    let onActivity!: (activity: Record<string, unknown>) => void;
    mockGetAnalystHandler.mockImplementation((_projectRoot, options) => {
      onActivity = (options as { onActivity: (activity: Record<string, unknown>) => void }).onActivity;
      return {
        handleMessage: jest.fn(async () => {
          onActivity({
            event: 'analysis_progress',
            message: `${'x'.repeat(250)} token=secret-activity-value .saivage/auth-profiles.json`,
            nested: {
              authorization: 'Bearer synthetic-secret',
              values: Array.from({ length: 12 }, (_unused, index) => `value-${index}`),
            },
          });
          return {
            message: {
              id: 'm-activity',
              role: 'assistant',
              kind: 'text',
              content: 'done',
              timestamp: new Date().toISOString(),
            },
          };
        }),
      };
    });
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    route.handler(ws, { headers: {}, query: {} });

    await handlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'message', content: { text: 'activity please' } })));

    const sent = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string));
    const activity = sent.find((entry) => entry.type === 'activity' && entry.content.event === 'analysis_progress');
    expect(activity).toBeTruthy();
    expect(activity.content.message.length).toBeLessThanOrEqual(200);
    expect(activity.content.nested.authorization).toBe('[REDACTED]');
    expect(activity.content.nested.values).toHaveLength(10);
    expect(JSON.stringify(activity)).not.toMatch(/secret-activity-value|synthetic-secret|auth-profiles\.json/);
    expect(JSON.stringify(activity)).toContain('[SECRET_PATH]');
  });

  it('preserves assistant response sanitization and the 200000 character message cap', async () => {
    const { ws, handlers } = createSocket();
    const { route, fastify } = createRoute();
    const oversized = 'a'.repeat(200_010);
    mockGetAnalystHandler.mockReturnValue({
      handleMessage: jest.fn(async () => ({
        message: {
          id: 'm-large',
          role: 'assistant',
          kind: 'text',
          api_key: 'secret-json-value',
          content: oversized,
          timestamp: new Date().toISOString(),
        },
      })),
    });
    registerWebSocket(fastify, '/tmp/project', createTestRuntimeApplication());
    route.handler(ws, { headers: {}, query: {} });

    await handlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'message', content: { text: 'large response' } })));

    const sent = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string));
    const reply = sent.find((entry) => entry.type === 'message');
    expect(reply).toBeTruthy();
    expect(reply.content.api_key).toBe('[REDACTED]');
    expect(reply.content.content.length).toBeLessThanOrEqual(200_000);
    expect(JSON.stringify(reply)).not.toMatch(/secret-oversized|secret-json-value|auth-profiles\.json/);
  });
});

describe('websocket runtime event fanout compatibility', () => {
  it('fans out a validator-covered session_cancelled runtime event without changing envelope JSON', () => {
    const { ws } = createSocket();
    const { route, fastify } = createRoute();
    const handlers: Array<(event: import('../../src/schemas/types.js').LoggedEvent) => void> = [];
    const runtime = {
      runtime: {},
      on: jest.fn(),
      subscribe: jest.fn((options: { handler: (event: import('../../src/schemas/types.js').LoggedEvent) => void }) => {
        handlers.push(options.handler);
        return { id: 'sub-1', pause: jest.fn(), resume: jest.fn(), unsubscribe: jest.fn() };
      }),
    } as any;
    registerWebSocket(fastify, '/tmp/project', runtime);
    route.handler(ws, { headers: {}, query: {} });
    websocketModule.wireRuntimeEvents(runtime);

    handlers[0]?.({ id: 'evt-1', kind: 'session_cancelled', timestamp: '2025-01-01T00:00:00.000Z', session_id: 'sess-1' });

    const payloads = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(payloads).toContainEqual({ type: 'status', content: { event: 'session_cancelled', session_id: 'sess-1' } });
    const fanout = payloads.find((entry) => entry.content.event === 'session_cancelled');
    expect(fanout).toBeTruthy();
  });



  it('fans out and validates runtime.run envelopes for root planner session binding updates', () => {
    const { ws } = createSocket();
    const { route, fastify } = createRoute();
    const handlers: Array<(event: import('../../src/schemas/types.js').LoggedEvent) => void> = [];
    const runtime = {
      runtime: {},
      on: jest.fn(),
      subscribe: jest.fn((options: { handler: (event: import('../../src/schemas/types.js').LoggedEvent) => void }) => {
        handlers.push(options.handler);
        return { id: 'sub-session-binding', pause: jest.fn(), resume: jest.fn(), unsubscribe: jest.fn() };
      }),
    } as any;
    registerWebSocket(fastify, '/tmp/project', runtime);
    route.handler(ws, { headers: {}, query: {} });
    websocketModule.wireRuntimeEvents(runtime);

    const run = {
      run_id: 'run-root-session-binding',
      kind: 'root',
      card_id: 'project',
      parent_run_id: null,
      command_id: 'cmd-start',
      activation_id: null,
      phase: 'planner',
      runtime_status: 'running',
      session_id: 'planner:project',
      started_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:01.000Z',
      result: null,
    } satisfies import('../../src/schemas/types.js').RuntimeRunRecord;
    handlers[0]?.({ id: 'evt-bind', kind: 'runtime_run', timestamp: '2026-01-01T00:00:01.000Z', run });

    const payloads = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string));
    const envelope = payloads.find((entry) => entry.content.event === 'runtime.run' && entry.content.run?.run_id === run.run_id);
    expect(envelope).toBeTruthy();
    expect(RuntimeRunEventSchema.parse(envelope).content.run).toEqual(run);
    expect(parseKnownWsEnvelope(envelope)).toEqual(envelope);
  });

  it('does not attach derived health fields to non-runtime-state runtime envelopes', () => {
    const envelope = createRuntimeEnvelope('goal_completed', { goal_id: 'goal-1' });

    expect(envelope).toEqual({ type: 'status', content: { event: 'goal_completed', goal_id: 'goal-1' } });
  });
});
