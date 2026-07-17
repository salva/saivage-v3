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
    let writes = 0;
    const partialWrite = ((fd: number, bytes: Uint8Array, offset: number, length: number) => { writes += 1; if (writes === 1) return writeSync(fd, bytes, offset, Math.floor(length / 2)); throw new Error('partial'); }) as typeof writeSync;
    expect(() => appendEnvelope(partialPath, serializeGrowingEnvelope([{ value: 2 }], row), { ...io, write: partialWrite })).toThrow('partial');
    expect(writes).toBe(2);
    expect(readCanonicalGrowingFile(partialPath, row)).toEqual([{ value: 1 }]);

    const completePath = target(); publishFirstEnvelope(completePath, serializeGrowingEnvelope([{ value: 1 }], row));
    expect(() => appendEnvelope(completePath, serializeGrowingEnvelope([{ value: 2 }], row), { ...io, fsync() { throw new Error('fsync'); } })).toThrow('fsync');
    expect(readCanonicalGrowingFile(completePath, row)).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it('exposes post-rename parent-open failure as outcome unknown', () => {
    const path = target(); let opens = 0;
    const replacement: ReplacementFileIo = { open(...args) { opens += 1; if (opens === 2) throw new Error('parent open'); return openSync(...args); }, write: writeSync, fsync: fsyncSync, close: closeSync, rename: renameSync };
    expect(() => publishFirstEnvelope(path, serializeGrowingEnvelope([{ value: 1 }], row), () => '22222222-2222-4222-8222-222222222222', replacement)).toThrow('parent open');
    expect(readCanonicalGrowingFile(path, row)).toEqual([{ value: 1 }]);
  });
});
