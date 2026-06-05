import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';
import { createTestRuntimeApplication } from '../helpers/test-runtime-application.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';

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
const { registerWebSocket, resetAnalystWebSocketState } = await import('../../src/server/websocket.js');

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

async function flushQueuedTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe('websocket analyst safety and live-sync control', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetOrCreateAnalystSession.mockReturnValue({ sessionId: 'session-1' });
    mockGetAnalystHandler.mockReturnValue({
      handleMessage: jest.fn(async () => ({ message: { role: 'assistant', content: 'ok' }, toolInvocations: [] })),
    });
    resetAnalystWebSocketState();
    delete process.env.SAIVAGE_API_TOKEN;
    resetAuthPolicyForTests();
  });

  it('accepts a valid one-use websocket ticket and sends only connected status on connect', () => {
    configureAuthPolicy({ apiToken: 'arch004-test-token' });
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', new LiveSyncSocket(), createTestRuntimeApplication());
    const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
    const { ws } = createSocket();

    route.handler(ws, { headers: {}, query: { ticket } });

    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledTimes(1);
    const status = JSON.parse((ws.send as jest.Mock).mock.calls[0]?.[0] as string);
    expect(status).toMatchObject({ type: 'status', content: { event: 'connected', sessionId: 'session-1' } });
  });

  it('handles conversation subscribe/unsubscribe frames without invoking the analyst handler', async () => {
    const liveSyncSocket = new LiveSyncSocket();
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', liveSyncSocket, createTestRuntimeApplication());
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
    expect(mockGetAnalystHandler).not.toHaveBeenCalled();
  });

  it('keeps analyst chat request/response behavior on the shared socket', async () => {
    const { route, fastify } = createRoute();
    registerWebSocket(fastify, '/tmp/project', new LiveSyncSocket(), createTestRuntimeApplication());
    const { ws, handlers } = createSocket();
    route.handler(ws, { headers: {}, query: {} });

    handlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'message', content: { text: 'hello' } })));
    await flushQueuedTurn();

    expect(mockGetAnalystHandler).toHaveBeenCalled();
    const payloads = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(payloads.some((payload) => payload.type === 'message' && payload.content.content === 'ok')).toBe(true);
  });
});
