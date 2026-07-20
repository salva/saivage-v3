import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { readCanonicalGrowingFile, readCanonicalGrowingFileSnapshot, type CanonicalGrowingFileReadIo } from '../../src/persistence/growing-file.js';

describe('canonical growing-file interrupted suffix handling', () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-growing-file-'));
    path = join(root, 'rows.jsonl');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('truncates only an unterminated final physical suffix', () => {
    const complete = '{"version":1,"type":"rows","rows":[{"id":"one"}]}\n';
    writeFileSync(path, `${complete}{"version":1`);

    expect(readCanonicalGrowingFile(path, z.object({ id: z.string() }).strict())).toEqual([{ id: 'one' }]);
    expect(readFileSync(path, 'utf8')).toBe(complete);
  });

  it('leaves complete malformed data present and fails', () => {
    const malformed = '{"version":1,"type":"rows","rows":[]}\n';
    writeFileSync(path, malformed);

    expect(() => readCanonicalGrowingFile(path, z.object({ id: z.string() }).strict())).toThrow('malformed');
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });

  it('keeps read, truncation, validation, and final metadata bound to the opened descriptor', () => {
    const complete = '{"version":1,"type":"rows","rows":[{"id":"opened"}]}\n';
    const replacement = '{"version":1,"type":"rows","rows":[{"id":"replacement"}]}\n';
    const openedPath = join(root, 'opened.jsonl');
    writeFileSync(path, `${complete}partial`);
    const operations: string[] = [];
    const io: CanonicalGrowingFileReadIo = {
      open(target, flags) {
        expect(flags).toBe(constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const descriptor = openSync(target, flags);
        renameSync(path, openedPath);
        writeFileSync(path, replacement);
        operations.push('open-and-replace');
        return descriptor;
      },
      stat(descriptor) { operations.push('fstat'); return fstatSync(descriptor); },
      read(descriptor) { operations.push('read'); return readFileSync(descriptor); },
      truncate(descriptor, length) { operations.push(`truncate:${length}`); ftruncateSync(descriptor, length); },
      fsync(descriptor) { operations.push('fsync'); fsyncSync(descriptor); },
      close(descriptor) { operations.push('close'); closeSync(descriptor); },
    };

    const snapshot = readCanonicalGrowingFileSnapshot(path, z.object({ id: z.string() }).strict(), io);

    expect(snapshot.rows).toEqual([{ id: 'opened' }]);
    expect(snapshot.bytes.toString()).toBe(complete);
    expect(snapshot.size).toBe(Buffer.byteLength(complete));
    expect(Number.isNaN(Date.parse(snapshot.modifiedAt))).toBe(false);
    expect(readFileSync(openedPath, 'utf8')).toBe(complete);
    expect(readFileSync(path, 'utf8')).toBe(replacement);
    expect(operations).toEqual(['open-and-replace', 'fstat', 'read', `truncate:${Buffer.byteLength(complete)}`, 'fsync', 'fstat', 'close']);
  });

  it('rejects final symlinks and non-regular objects without a read-only fallback', () => {
    const target = join(root, 'target.jsonl');
    writeFileSync(target, '{"version":1,"type":"rows","rows":[{"id":"one"}]}\n');
    symlinkSync(target, path);
    expect(() => readCanonicalGrowingFile(path, z.object({ id: z.string() }).strict())).toThrow();
    expect(() => readCanonicalGrowingFile('/dev/null', z.object({ id: z.string() }).strict())).toThrow('must be a regular file');
  });
});
