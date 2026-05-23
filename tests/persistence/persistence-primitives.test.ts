import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  AtomicJsonFile,
  JsonlLedger,
  LockOwnershipError,
  PersistenceValidationError,
  PersistenceVersionMismatch,
  PersistentQueue,
  ProjectLock,
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
  it('appends only under lock and quarantines malformed records on read', async () => {
    const path = join(root, 'events.jsonl');
    const ledger = new JsonlLedger<RecordValue>(path, recordSchema, lock);

    await expect(ledger.append({ acquired: true } as never, { id: 'a', value: 1 })).rejects.toThrow(LockOwnershipError);

    await lock.withLock(async (handle) => {
      await ledger.append(handle, { id: 'a', value: 1 });
    });
    writeFileSync(path, '{bad\n{"version":1,"data":{"id":"b","value":"wrong"}}\n{"version":1,"data":{"id":"c","value":3}}\n', { flag: 'a' });

    await expect(ledger.readAll()).resolves.toEqual([{ id: 'a', value: 1 }, { id: 'c', value: 3 }]);
    const quarantine = readFileSync(`${path}.quarantine`, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(quarantine).toHaveLength(2);
    expect(quarantine[0]).toMatchObject({ source: path, line_number: 2, line: '{bad' });
    expect(quarantine[1]).toMatchObject({ source: path, line_number: 3 });
  });

  it('reads from byte cursors and exposes stream replay', async () => {
    const ledger = new JsonlLedger<RecordValue>(join(root, 'cursor.jsonl'), recordSchema, lock);
    await lock.withLock(async (handle) => {
      await ledger.append(handle, { id: 'a', value: 1 });
    });
    const first = await ledger.readSince({ offset: 0 });
    await lock.withLock(async (handle) => {
      await ledger.append(handle, { id: 'b', value: 2 });
    });
    const second = await ledger.readSince(first.nextCursor);
    expect(second.records).toEqual([{ id: 'b', value: 2 }]);

    const streamed: RecordValue[] = [];
    for await (const record of ledger.stream()) streamed.push(record);
    expect(streamed).toEqual([{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
  });
});

describe('PersistentQueue', () => {
  it('uses FIFO semantics and requires lock handles for mutation', async () => {
    const queue = new PersistentQueue<RecordValue>(join(root, 'queue.json'), recordSchema, lock);
    const file = new AtomicJsonFile<RecordValue[]>(join(root, 'queue.json'), z.array(recordSchema), lock);
    await lock.withLock(async (handle) => file.write(handle, []));

    await expect(queue.enqueue({ acquired: true } as never, { id: 'a', value: 1 })).rejects.toThrow(LockOwnershipError);
    await lock.withLock(async (handle) => {
      await queue.enqueue(handle, { id: 'a', value: 1 });
      await queue.enqueue(handle, { id: 'b', value: 2 });
      await expect(queue.dequeue(handle)).resolves.toEqual({ id: 'a', value: 1 });
      await expect(queue.drain(handle)).resolves.toEqual([{ id: 'b', value: 2 }]);
    });
    expect(queue.snapshot()).toEqual([]);
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
