import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, isLocked, releaseLock, removeStaleLock } from '../../src/runtime/lock.js';

describe('runtime lock', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-lock-'));
    mkdirSync(join(projectRoot, '.saivage', 'locks'), { recursive: true });
  });

  afterEach(() => {
    try {
      releaseLock(projectRoot);
    } catch {
      // ignore cleanup races in tests
    }
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('prevents a second live runtime from acquiring the same lock', () => {
    const payload = acquireLock(projectRoot);

    expect(payload.pid).toBe(process.pid);
    expect(isLocked(projectRoot)).toBe(true);
    expect(() => acquireLock(projectRoot)).toThrow(/Cannot acquire lock/);

    releaseLock(projectRoot);
    expect(isLocked(projectRoot)).toBe(false);
    expect(acquireLock(projectRoot).pid).toBe(process.pid);
  });

  it('removes stale locks for dead PIDs or expired live PIDs', () => {
    const lockPath = join(projectRoot, '.saivage', 'locks', 'runtime.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, started_at: new Date().toISOString() }), 'utf-8');

    expect(() => acquireLock(projectRoot)).not.toThrow();
    releaseLock(projectRoot);

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: oldDate }), 'utf-8');

    expect(() => acquireLock(projectRoot)).not.toThrow();
  });

  it('removeStaleLock preserves valid locks and removes dead locks', () => {
    const lockPath = join(projectRoot, '.saivage', 'locks', 'runtime.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf-8');

    removeStaleLock(projectRoot);
    expect(existsSync(lockPath)).toBe(true);

    releaseLock(projectRoot);
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, started_at: new Date().toISOString() }), 'utf-8');

    removeStaleLock(projectRoot);
    expect(existsSync(lockPath)).toBe(false);
  });
});
