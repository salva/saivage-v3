import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { run } from '../../src/cli.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { acquireRuntimeLifecycleLock, publishRuntimeControlEndpoint, releaseRuntimeLifecycleLock } from '../../src/runtime/lock.js';
import { runtimeProcessLockFile } from '../../src/persistence/layout.js';

const cwd = process.cwd();
afterEach(() => { process.chdir(cwd); jest.restoreAllMocks(); process.exitCode = 0; });
it('rejects conflicting effects and invalid filters before HTTP', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  for (const args of [ ['--dry-run', '--delete'], ['--before', '2026-10-24'],
    ['--before', '2026-02-30T12:00:00Z'], ['--before', '2026-10-24T12:00:00'],
    ['--target-bytes', '-1'], ['--target-bytes', '1e3'], ['--target-bytes', '9007199254740992'] ])
    await expect(run(['node', 'saivage', 'gc-work', ...args])).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('GC refuses dead, malformed and indeterminate synthetic locks without request, rewrite or config fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gc-cli-lock-'));
  createProjectIdentity(root, 'GC strict lock');
  writeFileSync(join(root, '.saivage/saivage.yaml'), 'invalid config must not be loaded');
  const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
  publishRuntimeControlEndpoint(lock, { origin: 'http://127.0.0.1:45901', auth: 'disabled' });
  const path = runtimeProcessLockFile(root), original = readFileSync(path);
  const fetch = jest.spyOn(globalThis, 'fetch');
  try {
    process.chdir(root);
    const dead = JSON.parse(original.toString()); dead.process_start_identity = '0';
    for (const bytes of [Buffer.from(JSON.stringify(dead)), Buffer.from('{malformed')]) {
      writeFileSync(path, bytes);
      await expect(run(['node', 'saivage', 'gc-work', '--delete'])).rejects.toThrow();
      expect(readFileSync(path)).toEqual(bytes);
    }
    writeFileSync(path, original);
    const probe = jest.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('synthetic denied probe'), { code: 'EPERM' }); });
    try {
      await expect(run(['node', 'saivage', 'gc-work'])).rejects.toThrow();
      expect(readFileSync(path)).toEqual(original);
    } finally { probe.mockRestore(); }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    writeFileSync(path, original); releaseRuntimeLifecycleLock(lock);
    process.chdir(cwd); rmSync(root, { recursive: true, force: true });
  }
});
it('default and explicit preview send the same strict mode only to the published live endpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gc-cli-'));
  const requests: Array<{ path: string | undefined; body: unknown }> = [];
  let status = 200;
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: request.url, body });
    reply.writeHead(status, { 'content-type': status === 200 ? 'application/x-ndjson' : 'application/json' });
    if (status === 200) reply.write(JSON.stringify({ type: 'progress', progress: { phase: 'inventory', elapsed_ms: 0, observed_count: 0 } }) + '\n');
    reply.end(JSON.stringify(status === 200 ? { type: 'result', response: { mode: body.mode, disposition: 'refused',
      reason: 'maintenance_refused', restoration: 'not_acquired', failure: { code: 'EACCES', syscall: 'open' }, result: null } } : {}) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
  try {
    createProjectIdentity(root, 'GC test');
    writeFileSync(join(root, '.saivage/saivage.yaml'), 'invalid config is not consulted');
    process.chdir(root);
    await expect(run(['node', 'saivage', 'gc-work'])).rejects.toThrow('interactive');
    const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    try {
      await expect(run(['node', 'saivage', 'gc-work'])).rejects.toThrow('runtime control unavailable');
      publishRuntimeControlEndpoint(lock, { origin: `http://127.0.0.1:${address.port}`, auth: 'disabled' });
      const output = jest.spyOn(console, 'log').mockImplementation(() => {});
      const progress = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      progress.mockImplementationOnce(() => { throw new Error('Synthetic stderr failure'); });
      const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
      for (const args of [[], ['--dry-run'], ['--delete']])
        await run(['node', 'saivage', 'gc-work', ...args, '--before', '2026-10-24T12:00:00+02:00', '--target-bytes', '0']);
      expect(requests.map(request => request.path)).toEqual(Array(3).fill('/api/runtime/gc-work'));
      const bodies = requests.map(request => request.body as { mode: string });
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0]).toEqual({ mode: 'dry_run', before: '2026-10-24T12:00:00+02:00', target_bytes: 0 });
      expect(bodies[2].mode).toBe('delete');
      expect(process.exitCode).toBe(1);
      expect(progress.mock.calls.map(([text]) => text)).toEqual(Array(3).fill('GC inventory elapsed_ms=0 observed_count=0\n'));
      expect(process.listenerCount('SIGINT')).toBe(sigint);
      expect(process.listenerCount('SIGTERM')).toBe(sigterm);
      expect(output.mock.calls.map(([text]) => JSON.parse(text as string))).toEqual(
        bodies.map(({ mode }) => ({ mode, disposition: 'refused', reason: 'maintenance_refused',
          restoration: 'not_acquired', failure: { code: 'EACCES', syscall: 'open' }, result: null })),
      );
      status = 401;
      await expect(run(['node', 'saivage', 'gc-work'])).rejects.toThrow('401');
      expect(requests).toHaveLength(4);
    } finally { releaseRuntimeLifecycleLock(lock); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
});

it('incomplete real HTTP transport prints observations but no manufactured final stdout and removes signal listeners', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gc-cli-incomplete-'));
  let requests = 0;
  const server = createServer((_request, reply) => {
    requests++;
    reply.writeHead(200, { 'content-type': 'application/x-ndjson' });
    reply.end(JSON.stringify({ type: 'progress', progress: { phase: 'selection', elapsed_ms: 0, deleted_count: 1 } }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  createProjectIdentity(root, 'Synthetic incomplete GC');
  writeFileSync(join(root, '.saivage/saivage.yaml'), 'not loaded during live delegation');
  const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
  try {
    publishRuntimeControlEndpoint(lock, { origin: `http://127.0.0.1:${address.port}`, auth: 'disabled' });
    process.chdir(root);
    const stdout = jest.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    await expect(run(['node', 'saivage', 'gc-work', '--delete'])).rejects.toThrow('transport or response body read failed');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith('GC selection elapsed_ms=0 deleted_count=1\n');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
    expect(requests).toBe(1);
  } finally {
    releaseRuntimeLifecycleLock(lock); process.chdir(cwd);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
