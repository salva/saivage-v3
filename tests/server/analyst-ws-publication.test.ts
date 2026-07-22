import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';

import { AppLogPublicationError } from '../../src/persistence/app-log.js';
import { AnalystWsHandler } from '../../src/server/analyst-ws-handler.js';
import { registerWebSocket } from '../../src/server/websocket.js';

describe('Analyst WebSocket publication propagation', () => {
  it('rejects with the exact publication error and sends no ordinary error or acknowledgement frame', async () => {
    const error = new AppLogPublicationError('provider_exchange', new Error('hostile analyst publication cause'));
    const sendToClient = jest.fn();
    const handler = new AnalystWsHandler({
      projectRoot: '.',
      saivageConfig: {} as never,
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystRuntime: { submit: async () => { throw error; } } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;
    await expect(handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'inspect' } })))).rejects.toBe(error);
    expect(sendToClient).not.toHaveBeenCalled();
  });

  it('consumes production EventEmitter listener rejection without a frame or unsafe logging', async () => {
    const hostile = 'hostile publication cause must not be logged';
    const error = new AppLogPublicationError('provider_exchange', new Error(hostile));
    const handle = jest.spyOn(AnalystWsHandler.prototype, 'handleRawMessage').mockRejectedValue(error);
    let routeHandler!: (ws: WebSocket, request: { log: { error: jest.Mock } }) => void;
    const fastify = { get: (_path: string, _options: unknown, handler: typeof routeHandler) => { routeHandler = handler; } };
    const liveSyncSocket = { add: jest.fn(), delete: jest.fn(), clientCount: () => 1, isAdmissionOpen: () => true };
    registerWebSocket(fastify as never, '.', {
      authPolicy: { validateWebSocketRequest: () => ({ ok: true }) } as never,
      liveSyncSocket: liveSyncSocket as never,
      saivageConfig: {} as never,
      runtimeApplication: { analystSessionId: 'agent:analyst:global' } as never,
    });
    class TestSocket extends EventEmitter {
      readonly OPEN = 1;
      readyState = 1;
      readonly send = jest.fn();
      readonly close = jest.fn();
    }
    const ws = new TestSocket();
    const logError = jest.fn();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      routeHandler(ws as unknown as WebSocket, { log: { error: logError } });
      ws.send.mockClear();
      ws.emit('message', Buffer.from('{}'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(handle).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      { code: 'app_log_publication_failed', entryType: 'provider_exchange', transport: 'websocket' },
      'Required app-log publication failed',
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain(hostile);
    expect(JSON.stringify(logError.mock.calls)).not.toContain('publicationCause');
  });
});
