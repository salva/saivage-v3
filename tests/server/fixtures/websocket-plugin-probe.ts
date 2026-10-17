import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { connect, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import type { Environment } from '../../../src/config/environment.js';
import { AuthPolicy } from '../../../src/server/auth-policy.js';
import { createFastifyApp } from '../../../src/server/composition/fastify-app.js';
import { LiveSyncSocket } from '../../../src/server/live-sync-socket.js';
import { registerWebSocket } from '../../../src/server/websocket.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';

console.log(JSON.stringify({ probeRuntime: { execPath: process.execPath, version: process.version } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('WebSocket probe event deadline exceeded')), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(authPolicy = new AuthPolicy({}), logLevel = 'silent') {
  const app = await createFastifyApp({ nodeEnv: 'test', server: { logLevel } } as Environment, testApplicationFatalPort);
  const sync = new LiveSyncSocket();
  const clients: WebSocket[] = [];
  app.get('/probe-health', async () => ({ ok: true }));
  function wire(url: string, headers?: Record<string, string>) {
    const client = new WebSocket(url, { headers });
    clients.push(client);
    const frames: unknown[] = [];
    const firstFrame = deferred<unknown>();
    client.on('message', (bytes) => {
      const frame: unknown = JSON.parse(bytes.toString());
      frames.push(frame);
      firstFrame.resolve(frame);
    });
    return { client, frames, firstFrame: firstFrame.promise };
  }
  async function listen() {
    registerWebSocket(app, { authPolicy, liveSyncSocket: sync });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert(address && typeof address !== 'string');
    return { port: address.port, url: `ws://127.0.0.1:${address.port}/ws` };
  }
  async function cleanup() {
    for (const client of clients) if (client.readyState !== WebSocket.CLOSED) client.terminate();
    await bounded(app.close());
  }
  return { app, sync, wire, listen, cleanup };
}

async function healthy(f: Awaited<ReturnType<typeof fixture>>, url: string) {
  const request = get(new URL('/probe-health', url.replace('ws:', 'http:')), { agent: false });
  try {
    const [response] = await bounded(once(request, 'response'));
    response.resume();
    await bounded(once(response, 'end'));
    assert.equal(response.statusCode, 200);
  } finally { request.destroy(); }
  const connection = f.wire(url);
  assertConnected(await bounded(connection.firstFrame));
  const closed = once(connection.client, 'close');
  connection.client.close();
  await bounded(closed);
}

function assertConnected(frame: unknown) {
  assert.deepEqual(frame, { type: 'status', content: {
    event: 'connected', timestamp: (frame as { content: { timestamp: string } }).content.timestamp, clientCount: 1,
  } });
  assert.equal(typeof (frame as { content: { timestamp: string } }).content.timestamp, 'string');
}

async function admission() {
  const policy = new AuthPolicy({ apiToken: 'SYNTHETIC_BEARER_PRIVATE' });
  const f = await fixture(policy);
  try {
    const { url } = await f.listen();
    const ticket = policy.issueWebSocketTicket().ticket;
    const admitted = f.wire(`${url}?ticket=${ticket}`);
    assertConnected(await bounded(admitted.firstFrame));
    const server = [...f.app.websocketServer.clients][0];
    const subscribed = once(admitted.client, 'message');
    admitted.client.send(JSON.stringify({ t: 'subscribe', resource: 'agents', lease: 'ordinary-close' }));
    await bounded(subscribed);
    const serverClosed = once(server, 'close');
    const clientClosed = once(admitted.client, 'close');
    admitted.client.close();
    await bounded(Promise.all([serverClosed, clientClosed]));
    assert.equal(f.sync.clientCount(), 0);
    assert.equal(f.app.websocketServer.clients.size, 0);
    assert.equal((f.sync as unknown as { subscriptions: WeakMap<WebSocket, unknown> }).subscriptions.has(server), false);
    for (const query of ['', '?ticket=invalid', `?ticket=${ticket}`]) {
      const rejected = f.wire(url + query);
      const [code, reason] = await bounded(once(rejected.client, 'close'));
      assert.equal(code, 1008);
      assert.equal(reason.toString(), 'Authentication failed');
      assert.deepEqual(rejected.frames, []);
      assert.equal(f.sync.clientCount(), 0);
    }
  } finally { await f.cleanup(); }
  const disabled = await fixture();
  try { await healthy(disabled, (await disabled.listen()).url); }
  finally { await disabled.cleanup(); }
}

async function establishedError() {
  const policy = new AuthPolicy({ apiToken: 'SYNTHETIC_BEARER_PRIVATE' });
  const f = await fixture(policy, 'info');
  let raw!: Socket;
  let upgradeErrors: Function[] = [];
  f.app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/ws')) {
      raw = request.raw.socket;
      upgradeErrors = raw.listeners('error');
    }
  });
  try {
    const { url } = await f.listen();
    const upgradeListeners = f.app.server.listeners('upgrade');
    assert.equal(upgradeListeners.length, 1);
    const ticket = policy.issueWebSocketTicket().ticket;
    const connection = f.wire(`${url}?ticket=${ticket}`, { authorization: 'Bearer SYNTHETIC_BEARER_PRIVATE' });
    assertConnected(await bounded(connection.firstFrame));
    for (const listener of upgradeErrors) assert(!raw.listeners('error').includes(listener as (err: Error) => void));
    assert(raw.listenerCount('error') > 0, 'ws must own errors after upgrade');
    const server = [...f.app.websocketServer.clients][0];
    assert.equal(f.sync.clientCount(), 1);
    const subscribed = once(connection.client, 'message');
    connection.client.send(JSON.stringify({ t: 'subscribe', resource: 'agents', lease: 'probe-lease' }));
    assert.deepEqual(JSON.parse((await bounded(subscribed))[0].toString()), { t: 'subscribed', resource: 'agents', lease: 'probe-lease' });
    const invalidated = once(connection.client, 'message');
    const hint = { resource: 'agent-membership' as const, scope: 'card' as const, card_id: 'project' as const };
    f.sync.invalidate(hint);
    assert.deepEqual(JSON.parse((await bounded(invalidated))[0].toString()), { t: 'invalidate', ...hint });
    const error = deferred<Error & { code?: string }>();
    server.once('error', error.resolve);
    const serverClosed = new Promise<void>((resolve) => server.once('close', () => resolve()));
    const clientClosed = once(connection.client, 'close');
    // A real TCP write, not ws.send(): illegal RSV2/RSV3 on the upgraded wire.
    const clientSocket = (connection.client as WebSocket & { _socket: Socket })._socket;
    clientSocket.write(Buffer.from([0xa2, 0x00]));
    assert.equal((await bounded(error.promise)).code, 'WS_ERR_UNEXPECTED_RSV_2_3');
    await bounded(Promise.all([serverClosed, clientClosed]));
    assert.equal(f.sync.clientCount(), 0);
    assert.equal(f.app.websocketServer.clients.size, 0);
    assert.deepEqual(connection.frames, [connection.frames[0],
      { t: 'subscribed', resource: 'agents', lease: 'probe-lease' }, { t: 'invalidate', ...hint }]);
    assert.equal((f.sync as unknown as { subscriptions: WeakMap<WebSocket, unknown> }).subscriptions.has(server), false);
    await healthy(f, `${url}?ticket=${policy.issueWebSocketTicket().ticket}`);
    await bounded(f.app.close());
    for (const listener of upgradeListeners) assert(!f.app.server.listeners('upgrade').includes(listener));
  } finally { await f.cleanup(); }
}

async function upgradeFault(injected: boolean) {
  const f = await fixture();
  const entered = deferred<Socket>();
  const release = deferred<void>();
  let first = true;
  f.app.addHook('onRequest', async (request) => {
    if (request.url === '/ws' && first) {
      first = false;
      entered.resolve(request.raw.socket);
      await release.promise;
    }
  });
  let client: Socket | undefined;
  try {
    const { port, url } = await f.listen();
    let upgrades = 0;
    f.app.websocketServer.on('connection', () => { upgrades++; });
    client = connect({ host: '127.0.0.1', port });
    await bounded(once(client, 'connect'));
    const clientClosed = once(client, 'close');
    let response = '';
    client.on('data', (bytes) => { response += bytes.toString(); });
    client.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    const raw = await bounded(entered.promise);
    const rawClosed = new Promise<void>((resolve) => raw.once('close', () => resolve()));
    if (injected) {
      // Explicit deterministic ownership probe, NOT evidence of a TCP fault.
      raw.emit('error', Object.assign(new Error('test-injected upgrade failure'), { code: 'TEST_UPGRADE_ERROR' }));
    } else {
      client.resetAndDestroy();
    }
    await bounded(Promise.all([rawClosed, clientClosed]));
    release.resolve();
    assert.equal(response, '');
    assert.equal(f.sync.clientCount(), 0);
    assert.equal(f.app.websocketServer.clients.size, 0);
    await healthy(f, url);
    assert.equal(upgrades, 1, 'only the fresh connection may reach WebSocket admission');
  } finally {
    release.resolve();
    client?.destroy();
    await f.cleanup();
  }
}

const scenario = process.argv[2];
switch (scenario) {
  case 'admission': await admission(); break;
  case 'established-error': await establishedError(); break;
  case 'tcp-reset': await upgradeFault(false); break;
  case 'injected-upgrade-error': await upgradeFault(true); break;
  default: throw new Error(`Unknown probe scenario: ${scenario}`);
}
console.log(JSON.stringify({ completed: scenario }));
