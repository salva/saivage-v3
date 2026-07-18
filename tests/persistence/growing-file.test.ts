import { afterEach, describe, expect, it } from '@jest/globals';
import { closeSync, ftruncateSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { appendEnvelope, parseGrowingFile, publishFirstEnvelope, readCanonicalGrowingFile, serializeGrowingEnvelope, type GrowingFileIo } from '../../src/persistence/growing-file.js';
import type { ReplacementFileIo } from '../../src/persistence/replace-file.js';

const roots: string[] = [];
const row = z.object({ value: z.number().int() }).strict();
const io: GrowingFileIo = { read: readFileSync, open: openSync, write: writeSync, fsync: fsyncSync, truncate: ftruncateSync, close: closeSync };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function target(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-growing-')); roots.push(root); return join(root, 'stream.jsonl'); }

describe('strict growing-file boundaries', () => {
  it('writes one newline-terminated envelope and rejects complete malformed data', () => {
    const path = target(); const bytes = serializeGrowingEnvelope([{ value: 1 }], row);
    publishFirstEnvelope(path, bytes, () => '11111111-1111-4111-8111-111111111111');
    appendEnvelope(path, serializeGrowingEnvelope([{ value: 2 }], row));
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(readCanonicalGrowingFile(path, row)).toEqual([{ value: 1 }, { value: 2 }]);
    expect(() => parseGrowingFile(path, '{"version":2,"type":"rows","rows":[{}]}\n', row)).toThrow(/malformed/);
  });

  it('truncates only an unterminated final suffix on a later owning read', () => {
    const path = target(); writeFileSync(path, `${serializeGrowingEnvelope([{ value: 1 }], row).toString()}partial`);
    expect(readCanonicalGrowingFile(path, row)).toEqual([{ value: 1 }]);
    expect(readFileSync(path, 'utf8')).toBe(serializeGrowingEnvelope([{ value: 1 }], row).toString());
  });

  it('treats partial append and complete-line fsync failure as outcome unknown without retry', () => {
    const partialPath = target(); publishFirstEnvelope(partialPath, serializeGrowingEnvelope([{ value: 1 }], row));
    const partialFailure = new Error('partial');
    const partialOperations: string[] = [];
    let writes = 0;
    const partialWrite = ((fd: number, bytes: Uint8Array, offset: number, length: number) => {
      writes += 1;
      if (writes === 1) { partialOperations.push('write:short'); return writeSync(fd, bytes, offset, Math.floor(length / 2)); }
      partialOperations.push('write:error');
      throw partialFailure;
    }) as typeof writeSync;
    const partialIo: GrowingFileIo = {
      read: readFileSync,
      open(path, flags) { partialOperations.push(`open:${path}`); return openSync(path, flags); },
      write: partialWrite,
      fsync(fd) { partialOperations.push('fsync'); fsyncSync(fd); },
      truncate: ftruncateSync,
      close(fd) { partialOperations.push('close'); closeSync(fd); },
    };
    let partialThrown: unknown;
    try { appendEnvelope(partialPath, serializeGrowingEnvelope([{ value: 2 }], row), partialIo); } catch (error) { partialThrown = error; }
    expect(partialThrown).toBe(partialFailure);
    expect(partialOperations).toEqual([`open:${partialPath}`, 'write:short', 'write:error', 'close']);

    const completePath = target(); publishFirstEnvelope(completePath, serializeGrowingEnvelope([{ value: 1 }], row));
    const fsyncFailure = new Error('fsync');
    const completeOperations: string[] = [];
    const completeIo: GrowingFileIo = {
      read: readFileSync,
      open(path, flags) { completeOperations.push(`open:${path}`); return openSync(path, flags); },
      write: ((...args: unknown[]) => { completeOperations.push('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync() { completeOperations.push('fsync'); throw fsyncFailure; },
      truncate: ftruncateSync,
      close(fd) { completeOperations.push('close'); closeSync(fd); },
    };
    let fsyncThrown: unknown;
    try { appendEnvelope(completePath, serializeGrowingEnvelope([{ value: 2 }], row), completeIo); } catch (error) { fsyncThrown = error; }
    expect(fsyncThrown).toBe(fsyncFailure);
    expect(completeOperations).toEqual([`open:${completePath}`, 'write', 'fsync', 'close']);
  });

  it('stops after a post-rename parent-open failure with an unknown outcome', () => {
    const path = target();
    const parent = join(path, '..');
    const temporaryId = '22222222-2222-4222-8222-222222222222';
    const temporary = join(parent, `.stream.jsonl.${temporaryId}.saivage-tmp`);
    const failure = new Error('parent open');
    const operations: string[] = [];
    let opens = 0;
    const replacement: ReplacementFileIo = {
      open(...args) {
        opens += 1;
        operations.push(`open:${args[0]}`);
        if (opens === 2) throw failure;
        return openSync(...args);
      },
      write: ((...args: unknown[]) => { operations.push('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync(fd) { operations.push('fsync'); fsyncSync(fd); },
      close(fd) { operations.push('close'); closeSync(fd); },
      rename(source, destination) { operations.push(`rename:${source}->${destination}`); renameSync(source, destination); },
    };
    let thrown: unknown;
    try { publishFirstEnvelope(path, serializeGrowingEnvelope([{ value: 1 }], row), () => temporaryId, replacement); } catch (error) { thrown = error; }
    expect(thrown).toBe(failure);
    expect(operations).toEqual([
      `open:${temporary}`, 'write', 'fsync', 'close',
      `rename:${temporary}->${path}`,
      `open:${parent}`,
    ]);
  });
});
