import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
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

describe('runtime lifecycle lock parent admission', () => {
  const roots: string[] = [];
  afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

  function root(prefix = 'saivage-runtime-lock-parent-'): string {
    const value = mkdtempSync(join(tmpdir(), prefix));
    roots.push(value);
    return value;
  }

  it('creates the exact two parent levels for bare init', () => {
    const projectRoot = root();
    const handle = acquireRuntimeLifecycleLock({ projectRoot, mode: 'init', config: { readProcessStartIdentity: () => 'start' } });
    expect(existsSync(join(projectRoot, '.saivage'))).toBe(true);
    expect(existsSync(join(projectRoot, '.saivage', 'locks'))).toBe(true);
    releaseRuntimeLifecycleLock(handle);
  });

  it('admits existing real parent directories', () => {
    const projectRoot = root();
    createProjectIdentity(projectRoot, 'Existing lock parents');
    mkdirSync(join(projectRoot, '.saivage', 'locks'));
    const handle = acquireRuntimeLifecycleLock({ projectRoot, mode: 'bound', config: { readProcessStartIdentity: () => 'start' } });
    releaseRuntimeLifecycleLock(handle);
  });

  it('creates only the missing locks level for a valid bound project', () => {
    const projectRoot = root();
    createProjectIdentity(projectRoot, 'Missing locks parent');
    const handle = acquireRuntimeLifecycleLock({ projectRoot, mode: 'bound', config: { readProcessStartIdentity: () => 'start' } });
    expect(existsSync(join(projectRoot, '.saivage', 'locks'))).toBe(true);
    releaseRuntimeLifecycleLock(handle);
  });

  it('rejects a file or symlink at the .saivage level in identity-first order', () => {
    const fileRoot = root();
    writeFileSync(join(fileRoot, '.saivage'), 'not a directory');
    let readStartCalled = false;
    expect(() => acquireRuntimeLifecycleLock({ projectRoot: fileRoot, mode: 'init', config: { readProcessStartIdentity: () => { readStartCalled = true; return 'start'; } } })).toThrow(/Project identity is unreadable/);
    expect(readStartCalled).toBe(false);

    const symlinkRoot = root();
    const target = root('saivage-runtime-lock-target-');
    symlinkSync(target, join(symlinkRoot, '.saivage'));
    expect(() => acquireRuntimeLifecycleLock({ projectRoot: symlinkRoot, mode: 'init', config: { readProcessStartIdentity: () => 'start' } })).toThrow(/Runtime lock parent .* must be a real directory/);
    expect(existsSync(join(target, 'locks'))).toBe(false);
  });

  it('rejects a file or symlink at the locks level', () => {
    for (const kind of ['file', 'symlink'] as const) {
      const projectRoot = root();
      createProjectIdentity(projectRoot, `Invalid ${kind} locks parent`);
      const locks = join(projectRoot, '.saivage', 'locks');
      if (kind === 'file') writeFileSync(locks, 'not a directory');
      else symlinkSync(root('saivage-runtime-lock-target-'), locks);
      expect(() => acquireRuntimeLifecycleLock({ projectRoot, mode: 'bound', config: { readProcessStartIdentity: () => 'start' } })).toThrow(/Runtime lock parent .* must be a real directory/);
    }
  });

  it('rejects missing bound identity and process-start failure before creating parents', () => {
    const boundRoot = root();
    let boundReadStartCalled = false;
    expect(() => acquireRuntimeLifecycleLock({ projectRoot: boundRoot, mode: 'bound', config: { readProcessStartIdentity: () => { boundReadStartCalled = true; return 'start'; } } })).toThrow(/Project identity is missing/);
    expect(boundReadStartCalled).toBe(false);
    expect(existsSync(join(boundRoot, '.saivage'))).toBe(false);

    const initRoot = root();
    expect(() => acquireRuntimeLifecycleLock({ projectRoot: initRoot, mode: 'init', config: { readProcessStartIdentity: () => { throw new Error('unavailable'); } } })).toThrow(/Cannot acquire runtime lock without the current process start identity/);
    expect(existsSync(join(initRoot, '.saivage'))).toBe(false);
  });
});
