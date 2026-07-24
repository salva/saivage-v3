import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireRuntimeLifecycleLock, publishRuntimeControlEndpoint, readRuntimeLockStatus, releaseRuntimeLifecycleLock, runtimeProcessIdentity, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

describe('five-way runtime lifecycle lock classification', () => {
  let root: string;
  let handle: RuntimeLifecycleLockHandle | null;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-runtime-lock-')); handle = null; createProjectIdentity(root, 'Lock test'); });
  afterEach(() => { if (handle) try { releaseRuntimeLifecycleLock(handle); } catch { /* replaced fixture */ } rmSync(root, { recursive: true, force: true }); });

  it('publishes the sole strict control endpoint authority', () => {
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    publishRuntimeControlEndpoint(handle, { origin: 'http://127.0.0.1:4321', auth: 'bearer' });
    const status = readRuntimeLockStatus(root);
    expect(status.kind).toBe('live');
    if (status.kind !== 'live') throw new Error('live lifecycle owner expected');
    expect(runtimeProcessIdentity(handle)).toEqual({ pid: status.record.pid, startedAt: status.record.started_at });
  });

  it('distinguishes missing, dead, indeterminate, and malformed without removal', () => {
    expect(readRuntimeLockStatus(root).kind).toBe('missing');
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    const lockPath = join(root, '.saivage', 'locks', 'runtime.lock');
    expect(readRuntimeLockStatus(root, { probeProcess: () => 'dead' }).kind).toBe('dead');
    expect(readRuntimeLockStatus(root, { probeProcess: () => 'indeterminate' }).kind).toBe('indeterminate');
    expect(readRuntimeLockStatus(root, { probeProcess: () => 'live', readProcessStartIdentity: () => { throw new Error('proc unavailable'); } }).kind).toBe('indeterminate');
    const bytes = readFileSync(lockPath);
    writeFileSync(lockPath, '{broken');
    expect(readRuntimeLockStatus(root).kind).toBe('malformed');
    expect(readFileSync(lockPath, 'utf8')).toBe('{broken');
    writeFileSync(lockPath, bytes);
  });

  it('classifies verified PID reuse as dead', () => {
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    expect(readRuntimeLockStatus(root, { probeProcess: () => 'live', readProcessStartIdentity: () => 'different' }).kind).toBe('dead');
  });

  it('fails malformed schema and project-root identity closed without changing bytes', () => {
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    const lockPath = join(root, '.saivage', 'locks', 'runtime.lock');
    const original = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    for (const mutated of [{ ...original, lifecycle_phase: 'starting' }, { ...original, canonical_root_hash: '0'.repeat(64) }]) {
      const bytes = `${JSON.stringify(mutated)}\n`;
      writeFileSync(lockPath, bytes);
      expect(readRuntimeLockStatus(root).kind).toBe('malformed');
      expect(readFileSync(lockPath, 'utf8')).toBe(bytes);
    }
  });

  it('treats a lock read failure as indeterminate rather than missing or live', () => {
    const unreadablePath = join(root, '.saivage', 'locks');
    mkdirSync(unreadablePath, { recursive: true });
    expect(readRuntimeLockStatus(root, { lockFilePath: unreadablePath }).kind).toBe('indeterminate');
  });

  it('repeats only a proven-zero first-write EINTR after known empty creation', () => {
    let writes = 0;
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound', config: { publicationIo: {
      open: openSync,
      write: ((...args: Parameters<typeof writeSync>) => { writes += 1; if (writes === 1) throw Object.assign(new Error('interrupted'), { code: 'EINTR', bytesWritten: 0 }); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync: fsyncSync,
      close: closeSync,
    } } });
    expect(writes).toBe(2);
    expect(readRuntimeLockStatus(root).kind).toBe('live');
  });

  it('leaves the known empty lock namespace and types unknown first-write failure', () => {
    const lockPath = join(root, '.saivage', 'locks', 'runtime.lock');
    expect(() => acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound', config: { publicationIo: {
      open: openSync,
      write: (() => { throw Object.assign(new Error('interrupted'), { code: 'EINTR' }); }) as typeof writeSync,
      fsync: fsyncSync,
      close: closeSync,
    } } })).toThrow(PublicationOutcomeUnknownError);
    expect(readFileSync(lockPath)).toHaveLength(0);
    expect(readRuntimeLockStatus(root).kind).toBe('malformed');
  });
});
