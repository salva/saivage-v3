import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  try {
    createProjectIdentity(root, 'GC test');
    writeFileSync(join(root, '.saivage/saivage.yaml'), 'invalid config is not consulted');
    process.chdir(root);
    await expect(run(['node', 'saivage', 'gc-work'])).rejects.toThrow('No live');
    const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    try {
      await expect(run(['node', 'saivage', 'gc-work'])).rejects.toThrow('runtime control unavailable');
      publishRuntimeControlEndpoint(lock, { origin: 'http://127.0.0.1:45901', auth: 'disabled' });
      const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ mode: body.mode, disposition: 'refused',
          reason: 'maintenance_refused', restoration: 'not_acquired', result: null }), { status: 200 });
      });
      jest.spyOn(console, 'log').mockImplementation(() => {});
      for (const args of [[], ['--dry-run'], ['--delete']])
        await run(['node', 'saivage', 'gc-work', ...args, '--before', '2026-10-24T12:00:00+02:00', '--target-bytes', '0']);
      expect(request.mock.calls.map(([url]) => url)).toEqual(Array(3).fill('http://127.0.0.1:45901/api/runtime/gc-work'));
      const bodies = request.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0]).toEqual({ mode: 'dry_run', before: '2026-10-24T12:00:00+02:00', target_bytes: 0 });
      expect(bodies[2].mode).toBe('delete');
      request.mockResolvedValue(new Response('{}', { status: 401 }));
      await expect(run(['node', 'saivage', 'gc-work'])).rejects.toThrow('401');
      expect(request).toHaveBeenCalledTimes(4);
    } finally { releaseRuntimeLifecycleLock(lock); }
  } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
});
