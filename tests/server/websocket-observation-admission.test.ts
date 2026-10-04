import { describe, expect, it, jest } from '@jest/globals';
import { WebSocket } from 'ws';
import type { Environment } from '../../src/config/environment.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { registerWebSocket } from '../../src/server/websocket.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

async function openFixture() {
  const app = await createFastifyApp({ nodeEnv: 'test', server: { logLevel: 'silent' } } as Environment, testApplicationFatalPort);
  const sync = new LiveSyncSocket();
  const connections = jest.spyOn(sync, 'add');
  const admission = jest.spyOn(sync, 'handleClientFrame');
  registerWebSocket(app, { authPolicy: new AuthPolicy({}), liveSyncSocket: sync });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const frames: unknown[] = [];
  socket.on('message', (bytes) => frames.push(JSON.parse(bytes.toString())));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const serverSocket = connections.mock.calls[0][0];
  const serverClosed = new Promise<void>((resolve) => serverSocket.once('close', () => resolve()));
  return { app, sync, socket, frames, admission, serverClosed };
}
async function turn(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 20)); }

describe('live observation-only socket admission', () => {
  it.each(['{', JSON.stringify({ type: 'message', content: { text: 'RESTART SERVER' } }), JSON.stringify({ t: 'subscribe', resource: 'agents', lease: 'x', extra: true })])('closes unsupported input without effects or acknowledgement %#', async (input) => {
    const fixture = await openFixture();
    try {
      const closed = new Promise<{ code: number; reason: string }>((resolve) => fixture.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
      fixture.socket.send(input);
      expect(await closed).toEqual({ code: 1008, reason: 'Invalid live-sync frame' });
      await fixture.serverClosed;
      expect(fixture.frames).toEqual([{ type: 'status', content: { event: 'connected', timestamp: expect.any(String), clientCount: 1 } }]);
      expect(fixture.sync.clientCount()).toBe(0);
      expect(fixture.admission.mock.results.every(({ value }) => value === false)).toBe(true);
    } finally { fixture.socket.terminate(); await fixture.app.close(); }
  });
  it('retains leases, invalidations, stale unsubscribe protection, and teardown', async () => {
    const fixture = await openFixture();
    try {
      const subscribe = { t: 'subscribe', resource: 'conversation', id: 'agent:analyst:global', lease: 'a' };
      fixture.socket.send(JSON.stringify(subscribe)); await turn();
      expect(fixture.frames).toContainEqual({ ...subscribe, t: 'subscribed' });
      const hint = { resource: 'conversation' as const, id: 'agent:analyst:global' as const, segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, visible_message_id: null };
      fixture.sync.invalidate(hint); await turn();
      expect(fixture.frames).toContainEqual({ t: 'invalidate', ...hint });
      fixture.socket.send(JSON.stringify({ ...subscribe, t: 'unsubscribe', lease: 'obsolete' })); await turn();
      fixture.sync.invalidate(hint); await turn();
      expect(fixture.frames.filter((frame) => (frame as { t?: string }).t === 'invalidate')).toHaveLength(2);
      fixture.socket.send(JSON.stringify({ ...subscribe, t: 'unsubscribe' })); await turn();
      fixture.sync.invalidate(hint); await turn();
      expect(fixture.frames.filter((frame) => (frame as { t?: string }).t === 'invalidate')).toHaveLength(2);
    } finally { fixture.socket.terminate(); await fixture.app.close(); }
  });
});
