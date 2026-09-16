import { describe, expect, it, jest } from '@jest/globals';
import { WebSocket } from 'ws';

import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import type { Environment } from '../../src/config/environment.js';
import { MAX_ANALYST_WS_FRAME_BYTES } from '../../src/contracts/index.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { registerWebSocket } from '../../src/server/websocket.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

describe('WebSocket inbound frame bound', () => {
  it('closes an oversized real frame with 1009 before Analyst admission', async () => {
    const fastify = await createFastifyApp({
      nodeEnv: 'test',
      server: { logLevel: 'silent' },
    } as Environment, testApplicationFatalPort);
    const submit = jest.fn();
    const runtimeApplication = {
      analystSessionId: 'agent:analyst:global',
      analystRuntime: { submit },
    } as unknown as RuntimeApplication;
    let client: WebSocket | undefined;

    try {
      registerWebSocket(fastify, {
        restartCapability: { available: false },
        authPolicy: new AuthPolicy({}),
        liveSyncSocket: new LiveSyncSocket(),
        runtimeApplication,
        fatalPort: testApplicationFatalPort,
      });
      await fastify.listen({ host: '127.0.0.1', port: 0 });
      const address = fastify.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP listener.');

      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      await observeOpen(client, 2_000);
      client.send(Buffer.alloc(MAX_ANALYST_WS_FRAME_BYTES + 1, 0x61));

      await expect(observeClose(client, 2_000)).resolves.toMatchObject({ code: 1009 });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      if (client && client.readyState !== WebSocket.CLOSED) client.terminate();
      await fastify.close();
    }
  });
});

function observeOpen(client: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket connection.')), timeoutMs);
    client.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    client.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function observeClose(client: WebSocket, timeoutMs: number): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for oversized WebSocket frame rejection.')), timeoutMs);
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
