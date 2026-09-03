import { describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';

import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { registerWebSocket } from '../../src/server/websocket.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

describe('WebSocket authentication rejection', () => {
  it.each([
    ['a missing ticket', ''],
    ['an invalid ticket', '?ticket=not-issued'],
  ])(
    'delivers policy close code and reason promptly for %s without admission',
    async (_case, query) => {
      const fastify = Fastify({ logger: false });
      const liveSyncSocket = new LiveSyncSocket();
      const analystSessionIdRead = jest.fn(() => 'agent:analyst:global' as const);
      const runtimeApplication = {
        get analystSessionId() {
          return analystSessionIdRead();
        },
      } as unknown as RuntimeApplication;
      let client: WebSocket | undefined;

      try {
        await fastify.register(websocket);
        registerWebSocket(fastify, {
          authPolicy: new AuthPolicy({ apiToken: 'test-bearer-token' }),
          liveSyncSocket,
          runtimeApplication,
          fatalPort: testApplicationFatalPort,
        });
        await fastify.listen({ host: '127.0.0.1', port: 0 });
        const address = fastify.server.address();
        if (!address || typeof address === 'string')
          throw new Error('Expected an ephemeral TCP listener.');

        const messages: string[] = [];
        const startedAt = Date.now();
        client = new WebSocket(`ws://127.0.0.1:${address.port}/ws${query}`);
        client.on('message', (data) => messages.push(data.toString()));
        const close = await observeClose(client, 2_000);

        expect(close).toEqual({ code: 1008, reason: 'Authentication failed' });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(messages).toEqual([]);
        expect(liveSyncSocket.clientCount()).toBe(0);
        expect(analystSessionIdRead).not.toHaveBeenCalled();
      } finally {
        if (client && client.readyState !== WebSocket.CLOSED) client.terminate();
        await fastify.close();
      }
    },
  );
});

function observeClose(
  client: WebSocket,
  timeoutMs: number,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for WebSocket authentication rejection.')),
      timeoutMs,
    );
    client.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    client.once('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}
