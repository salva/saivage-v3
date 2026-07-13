import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, assertRuntimeLifecycleLock, isLocked, readLiveLockHolder, releaseLock, removeStaleLock, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';

const deadPid = 99999999;
const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const validIso = '2026-01-01T00:00:00.000Z';

describe('runtime lock', () => {
  let projectRoot: string;
  let handle: RuntimeLifecycleLockHandle | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-lock-'));
    mkdirSync(join(projectRoot, '.saivage', 'locks'), { recursive: true });
  });

  afterEach(() => {
    if (handle) try { releaseLock(handle); } catch { /* already released */ }
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('prevents a second live runtime from acquiring the same lock', () => {
    handle = acquireLock(projectRoot);

    expect(() => assertRuntimeLifecycleLock(handle!, projectRoot)).not.toThrow();
    expect(isLocked(projectRoot)).toBe(true);
    expect(() => acquireLock(projectRoot)).toThrow(/Cannot acquire lock/);

    releaseLock(handle);
    expect(() => assertRuntimeLifecycleLock(handle!, projectRoot)).toThrow(/live runtime lifecycle lock/);
    expect(isLocked(projectRoot)).toBe(false);
    handle = acquireLock(projectRoot);
  });

  it('rejects foreign, wrong-root, and released ownership handles', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-lock-other-'));
    try {
      handle = acquireLock(projectRoot);
      expect(() => assertRuntimeLifecycleLock({} as RuntimeLifecycleLockHandle, projectRoot)).toThrow(/live runtime lifecycle lock/);
      expect(() => assertRuntimeLifecycleLock(handle!, otherRoot)).toThrow(/belongs to/);
      releaseLock(handle);
      expect(() => assertRuntimeLifecycleLock(handle!, projectRoot)).toThrow(/live runtime lifecycle lock/);
      expect(() => releaseLock(handle!)).toThrow(/already released/);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('removes dead-PID locks but refuses old valid locks held by live PIDs', () => {
    const lockPath = join(projectRoot, '.saivage', 'locks', 'runtime.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, started_at: new Date().toISOString() }), 'utf-8');

    handle = acquireLock(projectRoot);
    releaseLock(handle);

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: oldDate }), 'utf-8');

    expect(isLocked(projectRoot)).toBe(true);
    expect(readLiveLockHolder(projectRoot)).toEqual({ pid: process.pid, started_at: oldDate });
    expect(() => acquireLock(projectRoot)).toThrow(/live PID/);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual({ pid: process.pid, started_at: oldDate });
  });

  it('removeStaleLock preserves valid locks and removes dead locks', () => {
    const lockPath = join(projectRoot, '.saivage', 'locks', 'runtime.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: oldDate }), 'utf-8');

    removeStaleLock(projectRoot);
    expect(existsSync(lockPath)).toBe(true);

    unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, started_at: new Date().toISOString() }), 'utf-8');

    removeStaleLock(projectRoot);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('treats malformed payloads as removable rather than held by a live PID', () => {
    const lockPath = join(projectRoot, '.saivage', 'locks', 'runtime.lock');
    const malformedPayloads = [
      JSON.stringify({ pid: process.pid }),
      JSON.stringify({ pid: process.pid, started_at: null }),
      JSON.stringify({ pid: process.pid, started_at: 'not-a-date' }),
      JSON.stringify({ pid: 1.5, started_at: validIso }),
      JSON.stringify(['not-object']),
      '{ invalid json',
    ];

    for (const payload of malformedPayloads) {
      writeFileSync(lockPath, payload, 'utf-8');
      expect(isLocked(projectRoot)).toBe(false);
      expect(readLiveLockHolder(projectRoot)).toBeNull();
      removeStaleLock(projectRoot);
      expect(existsSync(lockPath)).toBe(false);

      writeFileSync(lockPath, payload, 'utf-8');
      handle = acquireLock(projectRoot);
      expect(isLocked(projectRoot)).toBe(true);
      releaseLock(handle);
    }
  });

  it('treats missing lock paths as absent for read and cleanup helpers', () => {
    rmSync(join(projectRoot, '.saivage'), { recursive: true, force: true });

    expect(isLocked(projectRoot)).toBe(false);
    expect(readLiveLockHolder(projectRoot)).toBeNull();
    expect(() => removeStaleLock(projectRoot)).not.toThrow();
  });

  it('throws and preserves an unreadable existing lock file', () => {
    if (process.getuid?.() === 0) return;
    const lockPath = join(projectRoot, '.saivage', 'locks', 'runtime.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: validIso }), 'utf-8');
    chmodSync(lockPath, 0o000);

    try {
      expect(() => acquireLock(projectRoot)).toThrow(/Cannot read runtime lock/);
      expect(() => isLocked(projectRoot)).toThrow(/Cannot read runtime lock/);
      expect(() => removeStaleLock(projectRoot)).toThrow(/Cannot read runtime lock/);
      expect(() => readLiveLockHolder(projectRoot)).toThrow(/Cannot read runtime lock/);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      chmodSync(lockPath, 0o600);
    }
  });
});
