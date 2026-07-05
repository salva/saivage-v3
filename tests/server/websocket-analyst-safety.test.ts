import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';
import { createTestRuntimeApplication, createTestSaivageConfig } from '../helpers/test-runtime-application.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';

const mockResolveAnalystSessionId = jest.fn<(id?: string) => string>();

jest.unstable_mockModule('../../src/agents/analyst-handler.js', () => ({
  AnalystHandler: jest.fn(),
  GLOBAL_ANALYST_SESSION_ID: 'analyst:global',
}));

jest.unstable_mockModule('../../src/agents/session-ids.js', () => ({
  GLOBAL_ANALYST_SESSION_ID: 'analyst:global',
  resolveAnalystSessionId: mockResolveAnalystSessionId,
  isSafeAgentSessionId: jest.fn(() => true),
  SAFE_AGENT_SESSION_ID_RE: /^[\w:.-]+$/,
}));

const authPolicyModule = await import('../../src/server/auth-policy.js');
const { configureAuthPolicy, getAuthPolicy, resetAuthPolicyForTests } = authPolicyModule;
const { registerWebSocket } = await import('../../src/server/websocket.js');

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

function createRuntimeApplicationWithAnalystRuntime(overrides: Partial<ReturnType<typeof createMockAnalystRuntime>> = {}) {
  const runtimeApplication = createTestRuntimeApplication();
  const analystRuntime = { ...createMockAnalystRuntime(), ...overrides };
  Object.defineProperty(runtimeApplication, 'analystRuntime', { value: analystRuntime });
  return { runtimeApplication, analystRuntime };
}

function createMockAnalystRuntime() {
  return {
    submit: jest.fn(async () => ({ sessionId: 'analyst:global', message: { id: 'm1', role: 'assistant' as const, kind: 'text' as const, content: 'ok', timestamp: new Date(0).toISOString() }, toolInvocations: [] })),
    cancel: jest.fn(() => true),
    shutdownSessionProcesses: jest.fn(async () => undefined),
    shutdown: jest.fn(async () => undefined),
    listSessions: jest.fn(() => []),
    setRequestServerRestart: jest.fn(),
  };
}

async function flushQueuedTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe('websocket analyst safety and live-sync control', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockResolveAnalystSessionId.mockReturnValue('session-1');
    delete process.env.SAIVAGE_API_TOKEN;
    resetAuthPolicyForTests();
  });

  it('accepts a valid one-use websocket ticket and sends only connected status on connect', () => {
    configureAuthPolicy({ apiToken: 'arch004-test-token' });
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', {
      liveSyncSocket: new LiveSyncSocket(),
      saivageConfig: createTestSaivageConfig(),
      runtimeApplication: createTestRuntimeApplication(),
      requestServerRestart: async () => undefined,
    });
    const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
    const { ws } = createSocket();

    route.handler(ws, { headers: {}, query: { ticket } });

    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledTimes(1);
    const status = JSON.parse((ws.send as jest.Mock).mock.calls[0]?.[0] as string);
    expect(status).toMatchObject({ type: 'status', content: { event: 'connected', sessionId: 'analyst:global' } });
  });

  it('handles conversation subscribe/unsubscribe frames without invoking the analyst handler', async () => {
    const liveSyncSocket = new LiveSyncSocket();
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', {
      liveSyncSocket,
      saivageConfig: createTestSaivageConfig(),
      runtimeApplication: createTestRuntimeApplication(),
      requestServerRestart: async () => undefined,
    });
    const { ws, handlers } = createSocket();
    route.handler(ws, { headers: {}, query: {} });

    handlers.get('message')?.(Buffer.from(JSON.stringify({ t: 'subscribe', resource: 'conversation', id: 'planner:g1' })));
    await flushQueuedTurn();
    liveSyncSocket.invalidate({ resource: 'conversation', id: 'planner:g1' });
    expect((ws.send as jest.Mock).mock.calls.some((call) => String(call[0]).includes('"resource":"conversation"'))).toBe(true);

    handlers.get('message')?.(Buffer.from(JSON.stringify({ t: 'unsubscribe', resource: 'conversation', id: 'planner:g1' })));
    await flushQueuedTurn();
    const callsBefore = (ws.send as jest.Mock).mock.calls.length;
    liveSyncSocket.invalidate({ resource: 'conversation', id: 'planner:g1' });
    expect((ws.send as jest.Mock).mock.calls.length).toBe(callsBefore);
    expect(ws.send).toHaveBeenCalled();
  });

  it('keeps analyst chat request/response behavior on the shared socket', async () => {
    const { route, fastify } = createRoute();
    const { runtimeApplication, analystRuntime } = createRuntimeApplicationWithAnalystRuntime();
    registerWebSocket(fastify, '/tmp/project', {
      liveSyncSocket: new LiveSyncSocket(),
      saivageConfig: createTestSaivageConfig(),
      runtimeApplication,
      requestServerRestart: async () => undefined,
    });
    const { ws, handlers } = createSocket();
    route.handler(ws, { headers: {}, query: {} });

    handlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'message', content: { text: 'hello' } })));
    await flushQueuedTurn();

    expect(analystRuntime.submit).toHaveBeenCalledWith('analyst:global', { userContent: 'hello' }, expect.any(Function));
    const payloads = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(payloads.some((payload) => payload.type === 'message' && payload.content.content === 'ok')).toBe(true);
  });

  it.each(['close', 'error'] as const)('shuts down Analyst session processes on websocket %s', (event) => {
    const { runtimeApplication, analystRuntime } = createRuntimeApplicationWithAnalystRuntime();
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', {
      liveSyncSocket: new LiveSyncSocket(),
      saivageConfig: createTestSaivageConfig(),
      runtimeApplication,
      requestServerRestart: async () => undefined,
    });
    const { ws, handlers } = createSocket();
    route.handler(ws, { headers: {}, query: {} });

    handlers.get(event)?.();

    expect(analystRuntime.cancel).toHaveBeenCalledWith('analyst:global', 'websocket closed');
    expect(analystRuntime.shutdownSessionProcesses).toHaveBeenCalledWith('analyst:global');
  });
});
