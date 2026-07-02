import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { z } from 'zod';
import {
  AtomicJsonFile,
  JsonlLedger,
  LockOwnershipError,
  PersistenceValidationError,
  PersistenceVersionMismatch,
  ProjectLock,
  StaleLockError,
} from '../../src/persistence/index.js';

let root: string;
let lock: ProjectLock;

const recordSchema = z.object({ id: z.string(), value: z.number() }).strict();
type RecordValue = z.infer<typeof recordSchema>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-persistence-primitives-'));
  lock = new ProjectLock(join(root, '.saivage', '.lock'), { timeoutMs: 100 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});


describe('ProjectLock', () => {
  function writeLockMetadata(metadata: { pid: number; acquired_at: string; hostname: string }): void {
    mkdirSync(dirname(lock.lockPath), { recursive: true });
    writeFileSync(lock.lockPath, JSON.stringify(metadata) + '\n', 'utf-8');
  }

  it('serializes overlapping async callers on the same instance', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstHasEntered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = lock.withLock(async () => {
      events.push('first-enter');
      firstEntered();
      await firstMayFinish;
      events.push('first-exit');
    });

    await firstHasEntered;

    const second = lock.withLock(async () => {
      events.push('second-enter');
    });

    await Promise.resolve();
    expect(events).toEqual(['first-enter']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);
  });

  it('rejects stale handles after the lock is released', async () => {
    let staleHandle: Parameters<typeof lock.assertOwns>[0] | undefined;

    await lock.withLock(async (handle) => {
      staleHandle = handle;
      expect(() => lock.assertOwns(handle)).not.toThrow();
    });

    expect(() => lock.assertOwns(staleHandle as Parameters<typeof lock.assertOwns>[0])).toThrow(LockOwnershipError);
  });

  it('errors on stale same-host dead-pid locks by default', async () => {
    writeLockMetadata({ pid: 999_999_999, acquired_at: '2026-01-01T00:00:00.000Z', hostname: hostname() });

    await expect(lock.withLock(async () => undefined)).rejects.toThrow(StaleLockError);
  });

  it('removes stale same-host dead-pid locks when configured', async () => {
    writeLockMetadata({ pid: 999_999_999, acquired_at: '2026-01-01T00:00:00.000Z', hostname: hostname() });
    const recoveringLock = new ProjectLock(lock.lockPath, { timeoutMs: 100, staleLockAction: 'remove' });

    await expect(recoveringLock.withLock(async () => 'ok')).resolves.toBe('ok');
    expect(existsSync(lock.lockPath)).toBe(false);
  });

  it('rejects invalid and different-host lock metadata conservatively', async () => {
    mkdirSync(dirname(lock.lockPath), { recursive: true });
    writeFileSync(lock.lockPath, '{bad', 'utf-8');
    await expect(lock.withLock(async () => undefined)).rejects.toThrow(StaleLockError);

    writeLockMetadata({ pid: 999_999_999, acquired_at: '2026-01-01T00:00:00.000Z', hostname: 'different-host' });
    await expect(lock.withLock(async () => undefined)).rejects.toThrow(StaleLockError);
  });

  it('retries live locks asynchronously until timeout and fails sync immediately', async () => {
    writeLockMetadata({ pid: process.pid, acquired_at: new Date().toISOString(), hostname: hostname() });
    const shortLock = new ProjectLock(lock.lockPath, { timeoutMs: 10, retryDelayMs: 1 });

    await expect(shortLock.withLock(async () => undefined)).rejects.toThrow(/Timed out waiting 10ms/);
    expect(() => shortLock.withLockSync(() => undefined)).toThrow(/Timed out waiting 0ms/);
  });

  it('keeps sync acquisition fail-fast when an async lock is queued in-process', async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstHasEntered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = lock.withLock(async () => {
      firstEntered();
      await firstMayFinish;
    });

    await firstHasEntered;
    const second = lock.withLock(async () => undefined);

    expect(() => lock.withLockSync(() => undefined)).toThrow(/Timed out waiting 0ms/);

    releaseFirst();
    await Promise.all([first, second]);
  });
});

describe('AtomicJsonFile', () => {
  it('requires an active project lock handle for writes and updates', async () => {
    const file = new AtomicJsonFile<RecordValue>(join(root, 'state.json'), recordSchema, lock);
    await expect(file.write({ acquired: true } as never, { id: 'a', value: 1 })).rejects.toThrow(LockOwnershipError);

    await lock.withLock(async (handle) => {
      await file.write(handle, { id: 'a', value: 1 });
      await file.update(handle, (cur) => ({ ...cur, value: cur.value + 1 }));
    });

    expect(file.read()).toEqual({ id: 'a', value: 2 });
  });

  it('fails closed on malformed JSON, schema errors, and version mismatch', async () => {
    const path = join(root, 'versioned.json');
    const file = new AtomicJsonFile<RecordValue>(path, recordSchema, lock, { version: 1 });

    writeFileSync(path, '{bad', 'utf-8');
    expect(() => file.read()).toThrow(/malformed JSON/);

    writeFileSync(path, JSON.stringify({ version: 1, data: { id: 'a', value: 'wrong' } }), 'utf-8');
    expect(() => file.read()).toThrow(PersistenceValidationError);

    writeFileSync(path, JSON.stringify({ version: 2, data: { id: 'a', value: 1 } }), 'utf-8');
    expect(() => file.read()).toThrow(PersistenceVersionMismatch);
  });
});

describe('JsonlLedger', () => {
  it('appends only under lock', async () => {
    const path = join(root, 'events.jsonl');
    const ledger = new JsonlLedger<RecordValue>(path, recordSchema, lock);

    expect(() => ledger.appendSync({ acquired: true } as never, { id: 'a', value: 1 })).toThrow(LockOwnershipError);

    await lock.withLock(async (handle) => {
      ledger.appendSync(handle, { id: 'a', value: 1 });
    });

    expect(readFileSync(path, 'utf-8')).toBe('{"version":1,"data":{"id":"a","value":1}}\n');
  });
});

describe('ordered write failure behavior', () => {
  it('keeps earlier writes durable when a later write in the same lock fails validation', async () => {
    const first = new AtomicJsonFile<RecordValue>(join(root, 'first.json'), recordSchema, lock);
    const second = new AtomicJsonFile<RecordValue>(join(root, 'second.json'), recordSchema, lock);

    await expect(lock.withLock(async (handle) => {
      await first.write(handle, { id: 'ok', value: 1 });
      await second.write(handle, { id: 'bad', value: 'wrong' } as never);
    })).rejects.toThrow(PersistenceValidationError);

    expect(first.read()).toEqual({ id: 'ok', value: 1 });
    expect(existsSync(join(root, 'second.json'))).toBe(false);
  });
});
