import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';

const mockGetOrCreateAnalystSession = jest.fn();
const mockGetAnalystHandler = jest.fn();
const mockResetAnalystHandlerCache = jest.fn();

jest.unstable_mockModule('../../src/agents/analyst-handler.js', () => ({
  getOrCreateAnalystSession: mockGetOrCreateAnalystSession,
  getAnalystHandler: mockGetAnalystHandler,
  resetAnalystHandlerCache: mockResetAnalystHandlerCache,
}));

const websocketModule = await import('../../src/server/websocket.js');
const {
  broadcast,
  broadcastAnalystToolInvoked,
  registerWebSocket,
  resetWebSocketState,
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

describe('websocket analyst safety', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetOrCreateAnalystSession.mockReturnValue({ sessionId: 'session-1' });
    resetWebSocketState();
    delete process.env.SAIVAGE_API_TOKEN;
  });

  it('broadcastAnalystToolInvoked bounds and redacts summaries', () => {
    const { ws } = createSocket();
    const route = { handler: undefined as any };
    const fastify = { addHook: jest.fn(), get: jest.fn((_path, _opts, handler) => { route.handler = handler; }) } as any;
    registerWebSocket(fastify, '/tmp/project');
    route.handler(ws, { headers: {}, query: {} });

    const longSummary = `${'a'.repeat(210)} apiKey=secret-123 .saivage/auth-profiles.json`;
    broadcastAnalystToolInvoked({ sessionId: 's1', tool: 'run_shell_command', success: true, summary: longSummary, classified_as: 'destructive' });

    const payload = JSON.parse((ws.send as jest.Mock).mock.calls.at(-1)?.[0] as string);
    expect(payload.content.summary.length).toBeLessThanOrEqual(200);
    expect(payload.content.summary).not.toMatch(/secret-123|auth-profiles\.json/i);
    expect(payload.content.summary).toContain('[SECRET_PATH]');
  });

  it('broadcast only reaches authenticated websocket clients', () => {
    process.env.SAIVAGE_API_TOKEN = 'top-secret';
    const route = { handler: undefined as any };
    const fastify = { addHook: jest.fn(), get: jest.fn((_path, _opts, handler) => { route.handler = handler; }) } as any;
    registerWebSocket(fastify, '/tmp/project');

    const authorized = createSocket();
    const unauthorized = createSocket();
    route.handler(authorized.ws, { headers: { authorization: 'Bearer top-secret' }, query: {} });
    route.handler(unauthorized.ws, { headers: {}, query: {} });

    broadcast({ type: 'activity', content: { event: 'ping' } });

    expect(authorized.ws.send).toHaveBeenCalled();
    expect(unauthorized.ws.close).toHaveBeenCalledWith(1008, 'Authentication failed');
    expect((unauthorized.ws.send as jest.Mock).mock.calls.some((call) => String(call[0]).includes('ping'))).toBe(false);
  });

  it('sanitizes direct tool_invocation params and result payloads', async () => {
    const { ws, handlers } = createSocket();
    const route = { handler: undefined as any };
    const fastify = { addHook: jest.fn(), get: jest.fn((_path, _opts, handler) => { route.handler = handler; }) } as any;
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
    registerWebSocket(fastify, '/tmp/project');
    route.handler(ws, { headers: {}, query: {} });

    await handlers.get('message')?.(Buffer.from(JSON.stringify({ type: 'message', content: { text: 'inspect secrets' } })));

    const sent = (ws.send as jest.Mock).mock.calls.map((call) => JSON.parse(call[0] as string));
    const invocation = sent.find((entry) => entry.type === 'activity' && entry.content.event === 'tool_invocation');
    expect(invocation).toBeTruthy();
    const text = JSON.stringify(invocation);
    expect(text).not.toMatch(/secret-123|secret-456|secret-789|auth-profiles\.json|\.env/);
    expect(text).toContain('[SECRET_PATH]');
  });
});
