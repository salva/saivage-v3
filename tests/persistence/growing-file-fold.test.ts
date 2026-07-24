import { constants } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import {
  foldCanonicalGrowingFileRows,
  readCanonicalGrowingFileFirstEnvelope,
  type CanonicalGrowingFileReadIo,
} from '../../src/persistence/growing-file.js';

const rowSchema = z.object({ id: z.string(), value: z.string() }).strict();
const envelope = (...rows: Array<z.infer<typeof rowSchema>>): Buffer => Buffer.from(`${JSON.stringify({ version: 1, type: 'rows', rows })}\n`);

describe('byte-first canonical growing-file fold', () => {
  it('applies open, admission, and ordinary read ownership without reclassifying failures', () => {
    const opened: string[] = [];
    const denied = new Error('open denied');
    const openFailure = { ...fakeIo(Buffer.alloc(0)).io, open() { opened.push('open'); throw denied; }, close() { opened.push('close'); } };
    expect(() => fold(openFailure)).toThrow(denied);
    expect(opened).toEqual(['open']);

    const statFailure = new Error('stat failed');
    const stat = fakeIo(envelope({ id: 'one', value: 'ok' }), undefined, new Error('close failed'));
    stat.io.stat = () => { stat.trace.push('stat-failure'); throw statFailure; };
    expect(() => fold(stat.io)).toThrow(statFailure);
    expect(stat.trace.at(-1)).toBe('close');

    const nonregular = fakeIo(envelope({ id: 'one', value: 'ok' }));
    nonregular.io.stat = () => ({ isFile: () => false } as never);
    expect(() => fold(nonregular.io)).toThrow(/regular file/);
    expect(nonregular.trace.at(-1)).toBe('close');

    const readFailure = new Error('read failed');
    const read = fakeIo(envelope({ id: 'one', value: 'ok' }));
    read.io.read = () => { read.trace.push('read-failure'); throw readFailure; };
    expect(() => fold(read.io)).toThrow(readFailure);
    expect(read.trace.at(-1)).toBe('close');
  });

  it('classifies through EOF, truncates and fsyncs before decoding, then folds in physical order', () => {
    const complete = envelope({ id: 'one', value: 'first' }, { id: 'two', value: 'second' });
    const fake = fakeIo(Buffer.concat([complete, Buffer.from([0xf0, 0x28, 0x8c])]));
    const phases: string[] = [];
    const result = foldCanonicalGrowingFileRows({
      path: '/canonical.jsonl', rowSchema, logicalId: (row) => row.id, initialState: [] as string[], chunkBytes: 7, io: fake.io,
      instrumentation: { onReadChunk(_position, _bytes, phase) { phases.push(phase); } },
      reduce(state, row) { state.push(row.id); return state; },
    });
    expect(result.state).toEqual(['one', 'two']);
    expect(fake.bytes()).toEqual(complete);
    expect(fake.trace).toContain(`truncate:${complete.byteLength}`);
    expect(fake.trace.indexOf('fsync')).toBeLessThan(fake.trace.indexOf('close'));
    expect(phases.indexOf('parse')).toBeGreaterThan(phases.lastIndexOf('classify'));
    expect(result.canonicalBytesRead).toBe(complete.byteLength * 2);
    expect(fake.trace.at(-1)).toBe('close');
  });

  it('keeps complete invalid UTF-8 and malformed complete envelopes present', () => {
    const invalid = Buffer.from([0x7b, 0xff, 0x7d, 0x0a]);
    const invalidFake = fakeIo(invalid);
    expect(() => fold(invalidFake.io)).toThrow(/malformed/);
    expect(invalidFake.bytes()).toEqual(invalid);
    expect(invalidFake.trace.at(-1)).toBe('close');

    const malformed = Buffer.from('{"version":2,"type":"rows","rows":[{}]}\n');
    const malformedFake = fakeIo(malformed);
    expect(() => fold(malformedFake.io)).toThrow(/malformed/);
    expect(malformedFake.bytes()).toEqual(malformed);
  });

  it.each(['truncate', 'fsync'] as const)('abandons the descriptor at failed %s with the shared unknown-outcome error', (failure) => {
    const fake = fakeIo(Buffer.concat([envelope({ id: 'one', value: 'ok' }), Buffer.from('partial')]), failure);
    const callbacks: string[] = [];
    expect(() => foldCanonicalGrowingFileRows({
      path: '/canonical.jsonl', rowSchema, logicalId: (row) => row.id, initialState: 0, io: fake.io,
      instrumentation: { onEnvelope() { callbacks.push('envelope'); } }, reduce: (count) => count + 1,
    })).toThrow(PublicationOutcomeUnknownError);
    expect(fake.trace.at(-1)).toBe(failure);
    expect(fake.trace).not.toContain('close');
    expect(callbacks).toEqual([]);
  });

  it('resumes ordinary parse and close classification after successful truncate and fsync', () => {
    const malformed = fakeIo(Buffer.concat([Buffer.from('{bad}\n'), Buffer.from('partial')]));
    expect(() => fold(malformed.io)).toThrow(/malformed/);
    expect(malformed.trace.indexOf('truncate:6')).toBeLessThan(malformed.trace.indexOf('fsync'));
    expect(malformed.trace.indexOf('fsync')).toBeLessThan(malformed.trace.lastIndexOf('read:0:6'));
    expect(malformed.trace.at(-1)).toBe('close');

    const closeFailure = new Error('post-truncate close failed');
    const close = fakeIo(Buffer.concat([envelope({ id: 'one', value: 'ok' }), Buffer.from('partial')]), undefined, closeFailure);
    let thrown: unknown;
    try { fold(close.io); } catch (error) { thrown = error; }
    expect(thrown).toBe(closeFailure);
    expect(thrown).not.toBeInstanceOf(PublicationOutcomeUnknownError);
    expect(close.trace.at(-1)).toBe('close');
  });

  it('closes once for duplicate, reducer, replay, and close failures with ordinary precedence', () => {
    const duplicate = fakeIo(Buffer.concat([envelope({ id: 'same', value: 'a' }), envelope({ id: 'same', value: 'b' })]));
    expect(() => fold(duplicate.io)).toThrow(/duplicate logical id/);
    expect(duplicate.trace.filter((entry) => entry === 'close')).toHaveLength(1);

    const reducerFailure = new Error('reducer failed');
    const reducer = fakeIo(envelope({ id: 'one', value: 'a' }), undefined, new Error('close failed'));
    expect(() => foldCanonicalGrowingFileRows({ path: '/canonical.jsonl', rowSchema, logicalId: (row) => row.id, initialState: 0, io: reducer.io, reduce() { throw reducerFailure; } })).toThrow(reducerFailure);
    expect(reducer.trace.filter((entry) => entry === 'close')).toHaveLength(1);

    const replay = fakeIo(envelope({ id: 'one', value: 'a' }));
    expect(() => foldCanonicalGrowingFileRows({ path: '/canonical.jsonl', rowSchema, logicalId: (row) => row.id, initialState: 0, io: replay.io, reduce(_state, _row, checkpoint, reader) { reader.replayRow({ ...checkpoint, rowOrdinal: 99 }); return 0; } })).toThrow(/ordinal/);
    expect(replay.trace.filter((entry) => entry === 'close')).toHaveLength(1);

    const closeFailure = new Error('close failed');
    const close = fakeIo(envelope({ id: 'one', value: 'a' }), undefined, closeFailure);
    expect(() => fold(close.io)).toThrow(closeFailure);
    expect(close.trace.filter((entry) => entry === 'close')).toHaveLength(1);
  });

  it('bounds reads while buffering at most one complete envelope', () => {
    const bytes = Buffer.concat(Array.from({ length: 20 }, (_unused, index) => envelope({ id: `id-${index}`, value: 'x'.repeat(100) })));
    const fake = fakeIo(bytes);
    let largestEnvelope = 0;
    foldCanonicalGrowingFileRows({ path: '/canonical.jsonl', rowSchema, logicalId: (row) => row.id, initialState: 0, io: fake.io, chunkBytes: 13,
      instrumentation: { onReadChunk(_position, count) { expect(count).toBeLessThanOrEqual(13); }, onEnvelope(_start, _end, count) { largestEnvelope = Math.max(largestEnvelope, count); } },
      reduce: (count) => count + 1 });
    expect(largestEnvelope).toBeLessThan(bytes.byteLength / 2);
  });
});

describe('first-envelope canonical reader', () => {
  it('uses the same ordinary descriptor ownership for admission, read, decode, and parse failures', () => {
    const openTrace: string[] = [];
    const openFailure = new Error('open failed');
    const denied = { ...fakeIo(Buffer.alloc(0)).io, open() { openTrace.push('open'); throw openFailure; }, close() { openTrace.push('close'); } };
    expect(() => readCanonicalGrowingFileFirstEnvelope('/canonical.jsonl', rowSchema, denied)).toThrow(openFailure);
    expect(openTrace).toEqual(['open']);

    const nonregular = fakeIo(envelope({ id: 'one', value: 'ok' }));
    nonregular.io.stat = () => ({ isFile: () => false } as never);
    expect(() => readCanonicalGrowingFileFirstEnvelope('/canonical.jsonl', rowSchema, nonregular.io)).toThrow(/regular file/);
    expect(nonregular.trace.at(-1)).toBe('close');

    const readFailure = new Error('read failed');
    const read = fakeIo(envelope({ id: 'one', value: 'ok' }), undefined, new Error('close failed'));
    read.io.read = () => { throw readFailure; };
    expect(() => readCanonicalGrowingFileFirstEnvelope('/canonical.jsonl', rowSchema, read.io)).toThrow(readFailure);
    expect(read.trace.filter((entry) => entry === 'close')).toHaveLength(1);

    for (const bytes of [Buffer.from([0xff, 0x0a]), Buffer.from('{bad}\n'), Buffer.from('{"version":1,"type":"rows","rows":[{}]}\n')]) {
      const malformed = fakeIo(bytes);
      expect(() => readCanonicalGrowingFileFirstEnvelope('/canonical.jsonl', rowSchema, malformed.io)).toThrow(/malformed/);
      expect(malformed.trace.at(-1)).toBe('close');
      expect(malformed.bytes()).toEqual(bytes);
    }

    const closeFailure = new Error('close failed');
    const close = fakeIo(envelope({ id: 'one', value: 'ok' }), undefined, closeFailure);
    expect(() => readCanonicalGrowingFileFirstEnvelope('/canonical.jsonl', rowSchema, close.io)).toThrow(closeFailure);
    expect(close.trace.filter((entry) => entry === 'close')).toHaveLength(1);
  });

  it('parses every first-envelope row and never reads a later envelope', () => {
    const first = envelope({ id: 'one', value: 'first' }, { id: 'two', value: 'second' });
    const later = Buffer.from('{not-json}\n');
    const fake = fakeIo(Buffer.concat([first, later]));
    const result = readCanonicalGrowingFileFirstEnvelope('/canonical.jsonl', rowSchema, fake.io, 5);
    expect(result.rows.map((row) => row.id)).toEqual(['one', 'two']);
    expect(result.bytesRead).toBe(first.byteLength);
    expect(Math.max(...fake.readEnds)).toBe(first.byteLength);
    expect(fake.trace.at(-1)).toBe('close');
  });

  it('truncates a wholly unterminated file before ordinary empty failure and close', () => {
    const fake = fakeIo(Buffer.from([0xff, 0xfe, 0xfd]));
    expect(() => readCanonicalGrowingFileFirstEnvelope('/canonical.jsonl', rowSchema, fake.io, 2)).toThrow(/empty/);
    expect(fake.trace).toEqual(['open', 'stat', 'read:0:1', 'read:1:1', 'read:2:1', 'read:3:1', 'truncate:0', 'fsync', 'close']);
    expect(fake.bytes()).toHaveLength(0);
  });

  it.each(['truncate', 'fsync'] as const)('does no follow-up after wholly unterminated %s failure', (failure) => {
    const fake = fakeIo(Buffer.from('partial'), failure);
    expect(() => readCanonicalGrowingFileFirstEnvelope('/canonical.jsonl', rowSchema, fake.io, 3)).toThrow(PublicationOutcomeUnknownError);
    expect(fake.trace.at(-1)).toBe(failure);
    expect(fake.trace).not.toContain('close');
  });
});

function fold(io: CanonicalGrowingFileReadIo) {
  return foldCanonicalGrowingFileRows({ path: '/canonical.jsonl', rowSchema, logicalId: (row) => row.id, initialState: 0, io, reduce: (count) => count + 1 });
}

function fakeIo(initial: Buffer, failure?: 'truncate' | 'fsync', closeFailure?: Error) {
  let content = Buffer.from(initial);
  const trace: string[] = [];
  const readEnds: number[] = [];
  const io: CanonicalGrowingFileReadIo = {
    open(_path, flags) { trace.push('open'); expect(flags).toBe(constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); return 7; },
    stat() { trace.push('stat'); return { isFile: () => true, size: content.byteLength, mtime: new Date(0) } as never; },
    read(_descriptor, buffer, offset, length, position) {
      trace.push(`read:${position}:${length}`);
      readEnds.push(position + length);
      return content.copy(buffer, offset, position, Math.min(content.byteLength, position + length));
    },
    truncate(_descriptor, length) { trace.push('truncate' + `:${length}`); if (failure === 'truncate') { trace[trace.length - 1] = 'truncate'; throw new Error('truncate failed'); } content = content.subarray(0, length); },
    fsync() { trace.push('fsync'); if (failure === 'fsync') throw new Error('fsync failed'); },
    close() { trace.push('close'); if (closeFailure) throw closeFailure; },
  };
  return { io, trace, readEnds, bytes: () => content };
}
