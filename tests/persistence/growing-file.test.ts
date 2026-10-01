import { afterEach, describe, expect, it } from '@jest/globals';
import { constants, closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { admitGrowingFileTail, appendEnvelope, appendRequiredEnvelope, consumeGrowingFile, consumeGrowingRows, publishFirstEnvelope, readCanonicalBytes, readCanonicalBytesOrMissing, serializeGrowingEnvelope, type GrowingFileIo, type GrowingFileTruncationIo } from '../../src/persistence/growing-file.js';
import type { ReplacementFileIo } from '../../src/persistence/replace-file.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

const roots: string[] = [];
const row = z.object({ value: z.number().int() }).strict();
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function target(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-growing-')); roots.push(root); return join(root, 'stream.jsonl'); }
function bytes(value = 2): Buffer { return serializeGrowingEnvelope([{ value }]); }
function read(path: string) { return consumeGrowingRows(path, readCanonicalBytes(path), row, (rows) => rows); }

describe('exact growing-file boundaries', () => {
  it('serializes admitted typed rows without another schema parse and refuses empty batches', () => {
    let parses = 0;
    const schema = row.transform(({ value }) => { parses += 1; return { value: value * 2 }; });
    const admitted = schema.parse({ value: 3 });
    expect(JSON.parse(serializeGrowingEnvelope([admitted]).toString())).toEqual({ version: 1, type: 'rows', rows: [{ value: 6 }] });
    expect(parses).toBe(1);
    expect(() => serializeGrowingEnvelope([])).toThrow(/at least one/);
  });

  it('returns missing only from initial append open, with required append refusing absence', () => {
    const trace: string[] = [];
    const io: GrowingFileIo = { open() { trace.push('open'); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, write() { trace.push('write'); return 0; }, fsync() { trace.push('fsync'); }, close() { trace.push('close'); } };
    expect(appendEnvelope('/missing', bytes(), io)).toEqual({ kind: 'missing' });
    expect(trace).toEqual(['open']);
    expect(() => appendRequiredEnvelope('/missing', bytes(), io)).toThrow(/missing for append/);
    expect(readCanonicalBytesOrMissing(target())).toBeNull();
  });

  it('uses plain append flags and advances only the unsent short-write suffix', () => {
    const path = target(); writeFileSync(path, bytes(1));
    const trace: string[] = []; let flags = 0;
    const io: GrowingFileIo = {
      open(candidate, supplied) { trace.push('open'); flags = Number(supplied); return openSync(candidate, supplied); },
      write: ((fd: number, buffer: Uint8Array, offset: number, length: number) => { trace.push(`write:${offset}`); return writeSync(fd, buffer, offset, Math.min(3, length)); }) as typeof writeSync,
      fsync(fd) { trace.push('fsync'); fsyncSync(fd); }, close(fd) { trace.push('close'); closeSync(fd); },
    };
    expect(appendEnvelope(path, bytes(), io)).toEqual({ kind: 'appended' });
    expect(flags).toBe(constants.O_WRONLY | constants.O_APPEND);
    expect(trace.slice(0, 3)).toEqual(['open', 'write:0', 'write:3']);
    expect(trace.slice(-2)).toEqual(['fsync', 'close']);
    expect(read(path)).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it.each(['write', 'fsync', 'close'] as const)('stops immediately after append %s uncertainty', (phase) => {
    const trace: string[] = []; const failure = Object.assign(new Error(phase), { code: 'ENOENT' });
    const op = (name: string) => { trace.push(name); if (name === phase) throw failure; };
    const io: GrowingFileIo = { open() { op('open'); return 7; }, write: (() => { op('write'); return 1; }) as typeof writeSync, fsync() { op('fsync'); }, close() { op('close'); } };
    let thrown: unknown; try { appendEnvelope('/stream', Buffer.from('x'), io); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(PublicationOutcomeUnknownError);
    expect((thrown as PublicationOutcomeUnknownError).cause).toBe(failure);
    expect(trace).toEqual(['open', 'write', 'fsync', 'close'].slice(0, ['open', 'write', 'fsync', 'close'].indexOf(phase) + 1));
  });

  it.each([Buffer.from('partial'), Buffer.from([0xe2, 0x82]), bytes(2).subarray(0, -1)])('discards a final physical suffix only after prefix validation (%p)', (suffix) => {
    const path = target(); const prefix = bytes(1); writeFileSync(path, Buffer.concat([prefix, suffix]));
    const reads: string[] = [];
    const projection = consumeGrowingRows(path, readCanonicalBytes(path, { onRead: (p) => reads.push(p) }), row, (rows) => rows);
    expect(projection).toEqual([{ value: 1 }]); expect(readFileSync(path)).toEqual(prefix); expect(reads).toEqual([path]);
  });

  it.each([Buffer.alloc(0), Buffer.from('unterminated'), Buffer.from('\npartial'), Buffer.concat([bytes(1), Buffer.from('{bad}\npartial')]), Buffer.concat([bytes(1), Buffer.from([0xff, 0x0a]), Buffer.from('partial')])])('rejects empty, zero-prefix, and complete malformed data unchanged (%p)', (content) => {
    const path = target(); writeFileSync(path, content); expect(() => read(path)).toThrow(); expect(readFileSync(path)).toEqual(content);
  });

  it('does not truncate when the owner rejects retained-prefix semantics', () => {
    const path = target(); const content = Buffer.concat([bytes(1), bytes(1), Buffer.from('suffix')]); writeFileSync(path, content);
    expect(() => consumeGrowingRows(path, readCanonicalBytes(path), row, (rows) => { if (new Set(rows.map((r) => r.value)).size !== rows.length) throw new Error('duplicate'); })).toThrow('duplicate');
    expect(readFileSync(path)).toEqual(content);
  });

  it.each(['open', 'ftruncate', 'fsync', 'close'] as const)('keeps truncation %s failure final, open ordinary and later failures unknown', (phase) => {
    const failure = Object.assign(new Error(phase), { code: 'ENOENT' }); const trace: string[] = [];
    const op = (name: string) => { trace.push(name); if (name === phase) throw failure; };
    const io: GrowingFileTruncationIo = { open(_path, flags) { expect(flags).toBe(constants.O_RDWR); op('open'); return 7; }, ftruncate(_fd, length) { expect(length).toBe(bytes(1).length); op('ftruncate'); }, fsync() { op('fsync'); }, close() { op('close'); } };
    let thrown: unknown; try { consumeGrowingFile('/stream', Buffer.concat([bytes(1), Buffer.from('suffix')]), (prefix) => prefix, io); } catch (error) { thrown = error; }
    if (phase === 'open') expect(thrown).toBe(failure);
    else { expect(thrown).toBeInstanceOf(PublicationOutcomeUnknownError); expect((thrown as PublicationOutcomeUnknownError).cause).toBe(failure); }
    expect(trace).toEqual(['open', 'ftruncate', 'fsync', 'close'].slice(0, ['open', 'ftruncate', 'fsync', 'close'].indexOf(phase) + 1));
  });

  it('returns the validated projection without rereading or revalidating', () => {
    const trace: string[] = []; let validations = 0; const projection = {};
    const result = consumeGrowingFile('/stream', Buffer.concat([bytes(1), Buffer.from('suffix')]), () => { validations += 1; return projection; }, { open() { trace.push('open'); return 7; }, ftruncate() { trace.push('ftruncate'); }, fsync() { trace.push('fsync'); }, close() { trace.push('close'); } });
    expect(result).toBe(projection); expect(validations).toBe(1); expect(trace).toEqual(['open', 'ftruncate', 'fsync', 'close']);
  });

  it('healthy tail admission checks only the final envelope; torn admission validates the full prefix', () => {
    const path = target(); writeFileSync(path, Buffer.concat([Buffer.from('{earlier malformed}\n'), bytes(2)]));
    let validations = 0; const validate = () => { validations += 1; };
    expect(() => admitGrowingFileTail(path, row, validate)).not.toThrow(); expect(validations).toBe(0);
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('suffix')]));
    const before = readFileSync(path); expect(() => admitGrowingFileTail(path, row, validate)).toThrow(/malformed/); expect(readFileSync(path)).toEqual(before);
  });

  it('reads and appends exact paths without symlink proofs, but refuses first publication over any existing target', () => {
    const path = target(); const referent = join(path, '..', 'referent'); writeFileSync(referent, bytes(1)); symlinkSync(referent, path);
    expect(read(path)).toEqual([{ value: 1 }]); appendRequiredEnvelope(path, bytes()); expect(read(referent)).toHaveLength(2);
    for (const existing of [path, referent]) { const before = readFileSync(existing); expect(() => publishFirstEnvelope(existing, bytes())).toThrow(/already published/); expect(readFileSync(existing)).toEqual(before); }
    const directory = target(); mkdirSync(directory); expect(() => publishFirstEnvelope(directory, bytes())).toThrow(/already published/);
    const dangling = target(); symlinkSync(join(dangling, '..', 'absent'), dangling); expect(() => publishFirstEnvelope(dangling, bytes())).toThrow(/already published/);
  });

  it('stops after first-publication post-rename parent-open uncertainty', () => {
    const path = target(); const failure = new Error('parent open'); const trace: string[] = []; let opens = 0;
    const io: ReplacementFileIo = { open(...args) { opens += 1; trace.push('open'); if (opens === 2) throw failure; return openSync(...args); }, write: ((...args: unknown[]) => { trace.push('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync, fsync(fd) { trace.push('fsync'); fsyncSync(fd); }, close(fd) { trace.push('close'); closeSync(fd); }, rename(from, to) { trace.push('rename'); renameSync(from, to); } };
    expect(() => publishFirstEnvelope(path, bytes(1), () => '22222222-2222-4222-8222-222222222222', io)).toThrow(PublicationOutcomeUnknownError);
    expect(trace).toEqual(['open', 'write', 'fsync', 'close', 'rename', 'open']);
  });
});
