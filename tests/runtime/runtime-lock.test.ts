import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireRuntimeLifecycleLock,
  assertRuntimeLifecycleLock,
  bindRuntimeLifecycleLock,
  parseRuntimeLockOwnerRecord,
  publishRuntimeControlEndpoint,
  readRuntimeLockStatus,
  releaseRuntimeLifecycleLock,
  runtimeLifecycleLockRecord,
  type RuntimeLifecycleLockHandle,
  type RuntimeLockOwnerRecord,
} from '../../src/runtime/lock.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';
import { ProjectIdentityStore, projectIdentityDigest } from '../../src/persistence/project-identity-store.js';

describe('runtime lifecycle lock', () => {
  let root: string;
  let handle: RuntimeLifecycleLockHandle | undefined;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-runtime-lock-')); });
  afterEach(() => {
    if (handle) try { releaseRuntimeLifecycleLock(handle); } catch { /* test may have replaced ownership */ }
    rmSync(root, { recursive: true, force: true });
  });

  function createIdentity() {
    const { lane, authority } = createMutationLane();
    return new ProjectIdentityStore(root, lane, authority).create('Lock test');
  }

  function lockPath(): string { return join(root, '.saivage', 'locks', 'runtime.lock'); }

  it('creates one strict bootstrap record and binds it with the same owner', () => {
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' });
    const unbound = runtimeLifecycleLockRecord(handle);
    expect(unbound).toMatchObject({ format_version: 1, lock_state: 'bootstrap_unbound', project_identity: null, control_endpoint: null, pid: process.pid });
    expect(unbound.instance_id).not.toBe('');
    expect(unbound.process_start_identity).not.toBe('');
    expect(unbound.canonical_root_hash).toMatch(/^[a-f0-9]{64}$/);

    const project = createIdentity();
    bindRuntimeLifecycleLock(handle, projectIdentityDigest(project));
    expect(runtimeLifecycleLockRecord(handle)).toMatchObject({ lock_state: 'bound', project_identity: projectIdentityDigest(project), control_endpoint: null });
    expect(parseRuntimeLockOwnerRecord(JSON.parse(readFileSync(lockPath(), 'utf8')))).toEqual(runtimeLifecycleLockRecord(handle));
  });

  it('requires project identity for bound acquisition and publishes endpoint only once', () => {
    expect(() => acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' })).toThrow(/run 'saivage init'/);
    createIdentity();
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    publishRuntimeControlEndpoint(handle, { origin: 'http://127.0.0.1:4321', auth: 'bearer' });
    expect(runtimeLifecycleLockRecord(handle).control_endpoint).toEqual({ origin: 'http://127.0.0.1:4321', auth: 'bearer' });
    expect(() => publishRuntimeControlEndpoint(handle!, { origin: 'http://127.0.0.1:4322', auth: 'disabled' })).toThrow(/unpublished bound/);
  });

  it('uses one O_EXCL attempt and leaves every existing lock unchanged', () => {
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' });
    const before = readFileSync(lockPath());
    expect(() => acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' })).toThrow(/held by live PID/);
    expect(readFileSync(lockPath())).toEqual(before);

    releaseRuntimeLifecycleLock(handle);
    handle = undefined;
    const malformed = Buffer.from('{broken');
    writeFileSync(lockPath(), malformed);
    expect(() => acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' })).toThrow(/malformed or unreadable/);
    expect(readFileSync(lockPath())).toEqual(malformed);
  });

  it('classifies dead and PID-reused records as stale without removing them', () => {
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' });
    const record = runtimeLifecycleLockRecord(handle);
    releaseRuntimeLifecycleLock(handle);
    handle = undefined;
    writeFileSync(lockPath(), `${JSON.stringify(record)}\n`);
    const dead = readRuntimeLockStatus(root, { probeProcess: () => 'dead' });
    expect(dead.kind).toBe('dead_stale');
    if (dead.kind === 'dead_stale') expect(dead.repairInstruction).toContain(`rm -- '${lockPath()}'`);
    expect(readRuntimeLockStatus(root, { probeProcess: () => 'live', readProcessStartIdentity: () => 'different' }).kind).toBe('dead_stale');
    expect(existsSync(lockPath())).toBe(true);
  });

  it('classifies indeterminate liveness conservatively as live', () => {
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' });
    expect(readRuntimeLockStatus(root, { probeProcess: () => 'indeterminate' }).kind).toBe('live');
  });

  it('preserves a replaced lock on owner-only release', () => {
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' });
    const original = runtimeLifecycleLockRecord(handle);
    const replacement: RuntimeLockOwnerRecord = { ...original, instance_id: 'replacement-owner' };
    writeFileSync(lockPath(), `${JSON.stringify(replacement)}\n`);
    expect(() => releaseRuntimeLifecycleLock(handle!)).toThrow(/ownership changed/);
    expect(parseRuntimeLockOwnerRecord(JSON.parse(readFileSync(lockPath(), 'utf8'))).instance_id).toBe('replacement-owner');
    handle = undefined;
  });

  it('rejects foreign, wrong-root, released handles, and unavailable current process identity', () => {
    handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' });
    const other = mkdtempSync(join(tmpdir(), 'saivage-runtime-lock-other-'));
    try {
      expect(() => assertRuntimeLifecycleLock({} as RuntimeLifecycleLockHandle, root)).toThrow(/foreign/);
      expect(() => assertRuntimeLifecycleLock(handle!, other)).toThrow(/belongs to/);
      releaseRuntimeLifecycleLock(handle);
      expect(() => releaseRuntimeLifecycleLock(handle!)).toThrow(/already released/);
      handle = undefined;
      expect(() => acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init', config: { readProcessStartIdentity: () => { throw new Error('unavailable'); } } })).toThrow(/without the current process start identity/);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});
