import { afterEach, describe, expect, it } from '@jest/globals';
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { appendEnvelope, parseGrowingFile, prepareGrowingEnvelope, publishFirstEnvelope, readCanonicalGrowingFile, serializeGrowingEnvelope, type GrowingFileIo } from '../../src/persistence/growing-file.js';
import type { ReplacementFileIo } from '../../src/persistence/replace-file.js';

const roots: string[] = [];
const row = z.object({ value: z.number().int() }).strict();
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function target(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-growing-')); roots.push(root); return join(root, 'stream.jsonl'); }
function bytes(value = 2): Buffer { return serializeGrowingEnvelope([{ value }], row); }

describe('strict growing-file boundaries', () => {
  it('prepares parsed rows and their exact envelope bytes with one row-schema parse', () => {
    let parses = 0;
    const transformingRow = z.object({ value: z.number().int() }).strict().transform(({ value }) => {
      parses += 1;
      return { value: value * 2 };
    });

    const prepared = prepareGrowingEnvelope([{ value: 3 }], transformingRow);

    expect(parses).toBe(1);
    expect(prepared.rows).toEqual([{ value: 6 }]);
    expect(JSON.parse(prepared.bytes.toString('utf8'))).toEqual({ version: 1, type: 'rows', rows: [{ value: 6 }] });
  });

  it('returns missing only when the initial exact-path open reports ENOENT', () => {
    const operations: string[] = [];
    const io: GrowingFileIo = {
      open() { operations.push('open'); const error = Object.assign(new Error('missing'), { code: 'ENOENT' }); throw error; },
      stat() { operations.push('stat'); return fstatSync(-1); },
      write() { operations.push('write'); return 0; },
      fsync() { operations.push('fsync'); },
      close() { operations.push('close'); },
    };
    expect(appendEnvelope('/missing', bytes(), io)).toEqual({ kind: 'missing' });
    expect(operations).toEqual(['open']);
  });

  it('opens with the exact append flags, verifies a regular descriptor, completes partial writes, fsyncs, and closes once', () => {
    const path = target(); writeFileSync(path, bytes(1));
    const operations: string[] = [];
    let flags = 0;
    const io: GrowingFileIo = {
      open(candidate, suppliedFlags) { operations.push('open'); flags = Number(suppliedFlags); return openSync(candidate, suppliedFlags); },
      stat(fd) { operations.push('stat'); return fstatSync(fd); },
      write: ((fd: number, buffer: Uint8Array, offset: number, length: number) => { operations.push('write'); return writeSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2))); }) as typeof writeSync,
      fsync(fd) { operations.push('fsync'); fsyncSync(fd); },
      close(fd) { operations.push('close'); closeSync(fd); },
    };
    expect(appendEnvelope(path, bytes(), io)).toEqual({ kind: 'appended' });
    expect(flags).toBe(constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(operations[0]).toBe('open');
    expect(operations[1]).toBe('stat');
    expect(operations.filter((operation) => operation === 'write').length).toBeGreaterThan(1);
    expect(operations.slice(-2)).toEqual(['fsync', 'close']);
    expect(readCanonicalGrowingFile(path, row)).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it('rejects final symlinks without changing either target', () => {
    for (const dangling of [false, true]) {
      const link = target();
      const destination = join(link, '..', dangling ? 'absent.jsonl' : 'destination.jsonl');
      if (!dangling) writeFileSync(destination, 'original\n');
      symlinkSync(destination, link);
      expect(() => appendEnvelope(link, bytes())).toThrow();
      if (!dangling) expect(readFileSync(destination, 'utf8')).toBe('original\n');
    }
  });

  it('fails promptly for a FIFO without a reader and rejects an open FIFO descriptor before write', () => {
    const fifo = target();
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    expect(() => appendEnvelope(fifo, bytes())).toThrow();

    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    const operations: string[] = [];
    const io: GrowingFileIo = {
      open(path, flags) { operations.push('open'); return openSync(path, flags); },
      stat(fd) { operations.push('stat'); return fstatSync(fd); },
      write() { operations.push('write'); return 0; },
      fsync() { operations.push('fsync'); },
      close(fd) { operations.push('close'); closeSync(fd); },
    };
    try { expect(() => appendEnvelope(fifo, bytes(), io)).toThrow(/regular file/); }
    finally { closeSync(reader); }
    expect(operations).toEqual(['open', 'stat', 'close']);
  });

  it('rejects another non-regular descriptor before write', () => {
    const operations: string[] = [];
    const io: GrowingFileIo = {
      open() { operations.push('open'); return openSync('/dev/null', constants.O_WRONLY | constants.O_NONBLOCK); },
      stat(fd) { operations.push('stat'); return fstatSync(fd); },
      write() { operations.push('write'); return 0; },
      fsync() { operations.push('fsync'); },
      close(fd) { operations.push('close'); closeSync(fd); },
    };
    expect(() => appendEnvelope('/dev/null', bytes(), io)).toThrow(/regular file/);
    expect(operations).toEqual(['open', 'stat', 'close']);
  });

  it('propagates an initial non-ENOENT open failure without descriptor operations', () => {
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    const operations: string[] = [];
    const io: GrowingFileIo = {
      open() { operations.push('open'); throw failure; },
      stat() { operations.push('stat'); return fstatSync(-1); },
      write() { operations.push('write'); return 0; },
      fsync() { operations.push('fsync'); },
      close() { operations.push('close'); },
    };
    expect(() => appendEnvelope('/denied', bytes(), io)).toThrow(failure);
    expect(operations).toEqual(['open']);
  });

  it.each([
    ['stat', ['open', 'stat', 'close']],
    ['write', ['open', 'stat', 'write', 'close']],
    ['zero', ['open', 'stat', 'write', 'close']],
    ['fsync', ['open', 'stat', 'write', 'fsync', 'close']],
  ])('closes once and preserves the %s operation failure when close also fails', (phase: string, expected: string[]) => {
    const path = target(); writeFileSync(path, bytes(1));
    const failure = phase === 'write' ? Object.assign(new Error('post-open missing'), { code: 'ENOENT' }) : new Error(`${phase} failure`);
    const closeFailure = new Error('close failure');
    const operations: string[] = [];
    const io: GrowingFileIo = {
      open(candidate, flags) { operations.push('open'); return openSync(candidate, flags); },
      stat(fd) { operations.push('stat'); if (phase === 'stat') throw failure; return fstatSync(fd); },
      write: ((fd: number, buffer: Uint8Array, offset: number, length: number) => { operations.push('write'); if (phase === 'write') throw failure; if (phase === 'zero') return 0; return writeSync(fd, buffer, offset, length); }) as typeof writeSync,
      fsync(fd) { operations.push('fsync'); if (phase === 'fsync') throw failure; fsyncSync(fd); },
      close(fd) { operations.push('close'); closeSync(fd); throw closeFailure; },
    };
    let thrown: unknown;
    try { appendEnvelope(path, bytes(), io); } catch (error) { thrown = error; }
    if (phase === 'zero') expect(thrown).toEqual(expect.objectContaining({ message: expect.stringMatching(/no progress/) }));
    else expect(thrown).toBe(failure);
    expect(thrown).not.toBe(closeFailure);
    expect(operations).toEqual(expected);
  });

  it.each([
    ['stat', ['open', 'stat', 'close']],
    ['write', ['open', 'stat', 'write', 'close']],
    ['zero', ['open', 'stat', 'write', 'close']],
    ['fsync', ['open', 'stat', 'write', 'fsync', 'close']],
  ])('closes once and preserves the %s operation failure when close succeeds', (phase: string, expected: string[]) => {
    const path = target(); writeFileSync(path, bytes(1));
    const failure = new Error(`${phase} failure`);
    const operations: string[] = [];
    const io: GrowingFileIo = {
      open(candidate, flags) { operations.push('open'); return openSync(candidate, flags); },
      stat(fd) { operations.push('stat'); if (phase === 'stat') throw failure; return fstatSync(fd); },
      write: ((fd: number, buffer: Uint8Array, offset: number, length: number) => { operations.push('write'); if (phase === 'write') throw failure; if (phase === 'zero') return 0; return writeSync(fd, buffer, offset, length); }) as typeof writeSync,
      fsync(fd) { operations.push('fsync'); if (phase === 'fsync') throw failure; fsyncSync(fd); },
      close(fd) { operations.push('close'); closeSync(fd); },
    };
    let thrown: unknown;
    try { appendEnvelope(path, bytes(), io); } catch (error) { thrown = error; }
    if (phase === 'zero') expect(thrown).toEqual(expect.objectContaining({ message: expect.stringMatching(/no progress/) }));
    else expect(thrown).toBe(failure);
    expect(operations).toEqual(expected);
  });

  it('preserves non-regular validation failure when the one close also fails', () => {
    const closeFailure = new Error('close failure'); const operations: string[] = [];
    const io: GrowingFileIo = {
      open() { operations.push('open'); return openSync('/dev/null', constants.O_WRONLY | constants.O_NONBLOCK); },
      stat(fd) { operations.push('stat'); return fstatSync(fd); },
      write() { operations.push('write'); return 0; },
      fsync() { operations.push('fsync'); },
      close(fd) { operations.push('close'); closeSync(fd); throw closeFailure; },
    };
    let thrown: unknown;
    try { appendEnvelope('/dev/null', bytes(), io); } catch (error) { thrown = error; }
    expect(thrown).not.toBe(closeFailure);
    expect(thrown).toEqual(expect.objectContaining({ message: expect.stringMatching(/regular file/) }));
    expect(operations).toEqual(['open', 'stat', 'close']);
  });

  it('throws a lone close failure after one successful operation trace', () => {
    const path = target(); writeFileSync(path, bytes(1));
    const failure = new Error('close failure');
    const operations: string[] = [];
    const io: GrowingFileIo = {
      open(candidate, flags) { operations.push('open'); return openSync(candidate, flags); },
      stat(fd) { operations.push('stat'); return fstatSync(fd); },
      write: ((...args: unknown[]) => { operations.push('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync(fd) { operations.push('fsync'); fsyncSync(fd); },
      close(fd) { operations.push('close'); closeSync(fd); throw failure; },
    };
    expect(() => appendEnvelope(path, bytes(), io)).toThrow(failure);
    expect(operations).toEqual(['open', 'stat', 'write', 'fsync', 'close']);
  });

  it('writes one newline-terminated envelope and rejects complete malformed data', () => {
    const path = target(); publishFirstEnvelope(path, bytes(1), () => '11111111-1111-4111-8111-111111111111');
    expect(appendEnvelope(path, bytes())).toEqual({ kind: 'appended' });
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(() => parseGrowingFile(path, '{"version":2,"type":"rows","rows":[{}]}\n', row)).toThrow(/malformed/);
  });

  it('treats every existing exact path object as already published without mutating referents', () => {
    const regular = target();
    writeFileSync(regular, 'regular-original');
    expect(() => publishFirstEnvelope(regular, bytes())).toThrow(`Growing file '${regular}' is already published.`);
    expect(readFileSync(regular, 'utf8')).toBe('regular-original');

    const directory = target();
    mkdirSync(directory);
    expect(() => publishFirstEnvelope(directory, bytes())).toThrow(`Growing file '${directory}' is already published.`);

    for (const dangling of [false, true]) {
      const link = target();
      const destination = join(link, '..', dangling ? 'absent.jsonl' : 'referent.jsonl');
      if (!dangling) writeFileSync(destination, 'referent-original');
      symlinkSync(destination, link);
      expect(() => publishFirstEnvelope(link, bytes())).toThrow(`Growing file '${link}' is already published.`);
      if (!dangling) expect(readFileSync(destination, 'utf8')).toBe('referent-original');
    }
  });

  it('treats a FIFO as already published promptly without opening it', () => {
    const fifo = target();
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `import { publishFirstEnvelope } from './src/persistence/growing-file.ts'; try { publishFirstEnvelope(${JSON.stringify(fifo)}, Buffer.from('unused')); process.exitCode = 2; } catch (error) { if (!String(error).includes('already published')) process.exitCode = 3; }`,
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 3_000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
  });

  it('truncates only an unterminated final suffix on a later owning read', () => {
    const path = target(); writeFileSync(path, `${bytes(1).toString()}partial`);
    expect(readCanonicalGrowingFile(path, row)).toEqual([{ value: 1 }]);
    expect(readFileSync(path, 'utf8')).toBe(bytes(1).toString());
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
      open(...args) { opens += 1; operations.push(`open:${args[0]}`); if (opens === 2) throw failure; return openSync(...args); },
      write: ((...args: unknown[]) => { operations.push('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync(fd) { operations.push('fsync'); fsyncSync(fd); },
      close(fd) { operations.push('close'); closeSync(fd); },
      rename(source, destination) { operations.push(`rename:${source}->${destination}`); renameSync(source, destination); },
    };
    expect(() => publishFirstEnvelope(path, bytes(1), () => temporaryId, replacement)).toThrow(failure);
    expect(operations).toEqual([`open:${temporary}`, 'write', 'fsync', 'close', `rename:${temporary}->${path}`, `open:${parent}`]);
  });
});
