import { describe, expect, it } from '@jest/globals';
import { constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { appendEnvelope, readCanonicalGrowingFileSnapshot, readCappedCanonicalGrowingFileSnapshot, type CanonicalGrowingFileReadIo, type GrowingFileIo } from '../../src/persistence/growing-file.js';
import { replaceFile, type ReplacementFileIo } from '../../src/persistence/replace-file.js';
import { appendProcessOutputChunk, type ProcessOutputIo } from '../../src/runtime/process-runner.js';
import { acquireRuntimeLifecycleLock, type RuntimeLockPublicationIo } from '../../src/runtime/lock.js';

const regular = { isFile: () => true } as never;
const zeroEintr = Object.assign(new Error('interrupted before transfer'), { code: 'EINTR', bytesWritten: 0 });
const unknownEintr = Object.assign(new Error('interrupted with unknown transfer'), { code: 'EINTR' });
const failure = new Error('injected failure');

function replacementIo(failAt?: string, trace: string[] = []): ReplacementFileIo {
  let opens = 0;
  const operation = (name: string): void => { trace.push(name); if (name === failAt) throw failure; };
  return {
    open: ((_path: string, _flags: number) => { opens += 1; operation(opens === 1 ? 'temp-open' : 'parent-open'); return opens; }) as never,
    write: ((_fd: number, _bytes: Uint8Array, _offset: number, length: number) => { operation('temp-write'); return length; }) as never,
    fsync(fd: number) { operation(fd === 1 ? 'temp-fsync' : 'parent-fsync'); },
    close(fd: number) { operation(fd === 1 ? 'temp-close' : 'parent-close'); },
    rename() { operation('rename'); },
  };
}

describe('publication syscall boundaries', () => {
  it('repeats only a proven-zero temp write EINTR and advances short-write suffixes', () => {
    const calls: Array<[number, number]> = [];
    let writes = 0;
    const io: ReplacementFileIo = {
      open: (() => writes === -1 ? 9 : 8) as never,
      write: ((_fd: number, _bytes: Uint8Array, offset: number, length: number) => {
        calls.push([offset, length]);
        writes += 1;
        if (writes === 1) throw zeroEintr;
        return writes === 2 ? 2 : length;
      }) as never,
      fsync() {}, close() {}, rename() {},
    };
    replaceFile('/owner/state', Buffer.from('abcd'), () => '11111111-1111-4111-8111-111111111111', io);
    expect(calls).toEqual([[0, 4], [0, 4], [2, 2]]);
  });

  it.each(['temp-open', 'temp-write', 'temp-fsync', 'temp-close'] as const)('keeps replacement %s failure direct and stops immediately', (stage) => {
    const trace: string[] = [];
    expect(() => replaceFile('/owner/state', Buffer.from('x'), () => '11111111-1111-4111-8111-111111111111', replacementIo(stage, trace))).toThrow(failure);
    expect(trace.at(-1)).toBe(stage);
    expect(trace.filter((entry) => entry === stage)).toHaveLength(1);
  });

  it.each(['rename', 'parent-open', 'parent-fsync', 'parent-close'] as const)('types replacement %s failure and performs nothing later', (stage) => {
    const trace: string[] = [];
    expect(() => replaceFile('/owner/state', Buffer.alloc(0), () => '11111111-1111-4111-8111-111111111111', replacementIo(stage, trace))).toThrow(PublicationOutcomeUnknownError);
    expect(trace.at(-1)).toBe(stage);
    expect(trace.filter((entry) => entry === stage)).toHaveLength(1);
  });

  it('does not repeat replacement unknown-transfer EINTR or zero progress', () => {
    for (const result of [unknownEintr, 0]) {
      let writes = 0;
      const io = replacementIo();
      io.write = (() => { writes += 1; if (result instanceof Error) throw result; return result; }) as never;
      expect(() => replaceFile('/owner/state', Buffer.from('x'), () => '11111111-1111-4111-8111-111111111111', io)).toThrow(result instanceof Error ? result : /no progress/);
      expect(writes).toBe(1);
    }
  });

  it('types append EINTR after positive progress and performs no close', () => {
    const trace: string[] = [];
    let write = 0;
    const io: GrowingFileIo = {
      open() { trace.push('open'); return 7; }, stat() { trace.push('stat'); return regular; },
      write: ((_fd: number, _bytes: Uint8Array, _offset: number, _length: number) => { trace.push('write'); write += 1; if (write === 1) return 1; throw zeroEintr; }) as never,
      fsync() { trace.push('fsync'); }, close() { trace.push('close'); },
    };
    expect(() => appendEnvelope('/owner/app.jsonl', Buffer.from('ab'), io)).toThrow(PublicationOutcomeUnknownError);
    expect(trace).toEqual(['open', 'stat', 'write', 'write']);
  });

  it('keeps append acquisition and admission failures direct with exactly one permitted close', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(appendEnvelope('/owner/app.jsonl', Buffer.from('x'), { open() { throw missing; } } as never)).toEqual({ kind: 'missing' });
    const denied = new Error('denied');
    expect(() => appendEnvelope('/owner/app.jsonl', Buffer.from('x'), { open() { throw denied; } } as never)).toThrow(denied);
    const trace: string[] = [];
    const io: GrowingFileIo = { open() { return 1; }, stat() { trace.push('stat'); throw failure; }, write() { trace.push('write'); return 1; }, fsync() {}, close() { trace.push('close'); } } as never;
    expect(() => appendEnvelope('/owner/app.jsonl', Buffer.from('x'), io)).toThrow(failure);
    expect(trace).toEqual(['stat', 'close']);
  });

  it.each(['write', 'fsync', 'close'] as const)('types append %s uncertainty with no following operation', (stage) => {
    const trace: string[] = [];
    const operation = (name: string): void => { trace.push(name); if (name === stage) throw failure; };
    const io: GrowingFileIo = { open() { trace.push('open'); return 1; }, stat() { trace.push('stat'); return regular; }, write: ((_fd: number, _bytes: Uint8Array, _offset: number, length: number) => { operation('write'); return length; }) as never, fsync() { operation('fsync'); }, close() { operation('close'); } };
    expect(() => appendEnvelope('/owner/app.jsonl', Buffer.from('x'), io)).toThrow(PublicationOutcomeUnknownError);
    expect(trace.at(-1)).toBe(stage);
  });

  it('repeats only first zero-transfer append EINTR and advances short writes', () => {
    const offsets: number[] = []; let writes = 0;
    const io: GrowingFileIo = { open() { return 1; }, stat() { return regular; }, write: ((_fd: number, _bytes: Uint8Array, offset: number, length: number) => { offsets.push(offset); writes += 1; if (writes === 1) throw zeroEintr; return writes === 2 ? 1 : length; }) as never, fsync() {}, close() {} };
    expect(appendEnvelope('/owner/app.jsonl', Buffer.from('ab'), io)).toEqual({ kind: 'appended' });
    expect(offsets).toEqual([0, 0, 1]);
    const unknownIo = { ...io, write: (() => { throw unknownEintr; }) as never };
    expect(() => appendEnvelope('/owner/app.jsonl', Buffer.from('x'), unknownIo)).toThrow(PublicationOutcomeUnknownError);
    let zeroWrites = 0;
    expect(() => appendEnvelope('/owner/app.jsonl', Buffer.from('x'), { ...io, write: (() => { zeroWrites += 1; return 0; }) as never })).toThrow(PublicationOutcomeUnknownError);
    expect(zeroWrites).toBe(1);
  });

  it('keeps process-output ENOENT direct and types write uncertainty without close', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const missingIo: ProcessOutputIo = { open() { throw missing; }, stat() { return regular; }, write() { return 1; }, fsync() {}, close() {} } as never;
    expect(() => appendProcessOutputChunk('/owner/stdout.log', Buffer.from('x'), missingIo)).toThrow(missing);

    const trace: string[] = [];
    const failingIo: ProcessOutputIo = {
      open(_path: string, flags: number) { trace.push(`open:${flags}`); return 5; }, stat() { trace.push('stat'); return regular; },
      write() { trace.push('write'); throw new Error('unknown transfer'); }, fsync() { trace.push('fsync'); }, close() { trace.push('close'); },
    } as never;
    expect(() => appendProcessOutputChunk('/owner/stdout.log', Buffer.from('x'), failingIo)).toThrow(PublicationOutcomeUnknownError);
    expect(trace).toEqual([`open:${constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK}`, 'stat', 'write']);
  });

  it('binds process-output admission, short writes, zero EINTR, zero progress, fsync, and close', () => {
    const admissionTrace: string[] = [];
    const admission: ProcessOutputIo = { open() { return 1; }, stat() { admissionTrace.push('stat'); throw failure; }, write() { return 1; }, fsync() {}, close() { admissionTrace.push('close'); } } as never;
    expect(() => appendProcessOutputChunk('/owner/stdout.log', Buffer.from('x'), admission)).toThrow(failure);
    expect(admissionTrace).toEqual(['stat', 'close']);
    const offsets: number[] = []; let writes = 0;
    const short: ProcessOutputIo = { open() { return 1; }, stat() { return regular; }, write: ((_fd: number, _bytes: Uint8Array, offset: number, length: number) => { offsets.push(offset); writes += 1; if (writes === 1) throw zeroEintr; return writes === 2 ? 1 : length; }) as never, fsync() {}, close() {} };
    appendProcessOutputChunk('/owner/stdout.log', Buffer.from('ab'), short);
    expect(offsets).toEqual([0, 0, 1]);
    let zeroWrites = 0;
    expect(() => appendProcessOutputChunk('/owner/stdout.log', Buffer.from('x'), { ...short, write: (() => { zeroWrites += 1; return 0; }) as never })).toThrow(PublicationOutcomeUnknownError);
    expect(zeroWrites).toBe(1);
    for (const stage of ['write', 'fsync', 'close'] as const) {
      const trace: string[] = [];
      const operation = (name: string): void => { trace.push(name); if (name === stage) throw stage === 'write' ? unknownEintr : failure; };
      const io: ProcessOutputIo = { open() { trace.push('open'); return 1; }, stat() { trace.push('stat'); return regular; }, write: ((_fd: number, _bytes: Uint8Array, _offset: number, length: number) => { operation('write'); return stage === 'write' ? 0 : length; }) as never, fsync() { operation('fsync'); }, close() { operation('close'); } };
      expect(() => appendProcessOutputChunk('/owner/stdout.log', Buffer.from('x'), io)).toThrow(PublicationOutcomeUnknownError);
      expect(trace.at(-1)).toBe(stage);
    }
  });

  it.each(['stat', 'read', 'instrumentation'] as const)('closes the growing-file descriptor once while preserving pre-truncate %s failure', (stage) => {
    const trace: string[] = [];
    const content = Buffer.from('{}\n');
    const io: CanonicalGrowingFileReadIo = { open() { return 1; }, stat() { trace.push('stat'); if (stage === 'stat') throw failure; return regular; }, read(_fd, buffer, offset, length, position) { trace.push('read'); if (stage === 'read') throw failure; return content.copy(buffer, offset, position, Math.min(content.length, position + length)); }, truncate() {}, fsync() {}, close() { trace.push('close'); } };
    expect(() => readCanonicalGrowingFileSnapshot('/owner/app.jsonl', z.unknown(), io, stage === 'instrumentation' ? { onRead() { trace.push('instrumentation'); throw failure; } } : undefined)).toThrow(failure);
    expect(trace.filter((entry) => entry === 'close')).toHaveLength(1);
  });

  it('preserves the growing-file pre-truncate error when its sole close also fails', () => {
    let closes = 0;
    const io: CanonicalGrowingFileReadIo = { open() { return 1; }, stat() { throw failure; }, read() { return 0; }, truncate() {}, fsync() {}, close() { closes += 1; throw new Error('close failed'); } };
    expect(() => readCanonicalGrowingFileSnapshot('/owner/app.jsonl', z.unknown(), io)).toThrow(failure);
    expect(closes).toBe(1);
  });

  it('does not repeat the ordinary non-truncating success-path close', () => {
    const closeFailure = new Error('close failed'); let closes = 0;
    const content = Buffer.from('{"version":1,"type":"rows","rows":[{}]}\n');
    const io: CanonicalGrowingFileReadIo = { open() { return 1; }, stat() { return { isFile: () => true, size: 40, mtime: new Date(0) } as never; }, read(_fd, buffer, offset, length, position) { return content.copy(buffer, offset, position, Math.min(content.length, position + length)); }, truncate() {}, fsync() {}, close() { closes += 1; throw closeFailure; } };
    expect(() => readCanonicalGrowingFileSnapshot('/owner/app.jsonl', z.unknown(), io)).toThrow(closeFailure);
    expect(closes).toBe(1);
  });

  it.each(['truncate', 'fsync', 'final-stat', 'close'] as const)('types growing-file %s truncation uncertainty and stops', (stage) => {
    const trace: string[] = []; let stats = 0;
    const operation = (name: string): void => { trace.push(name); if (name === stage) throw failure; };
    const content = Buffer.from('{}\nX');
    const io: CanonicalGrowingFileReadIo = { open() { return 1; }, stat() { stats += 1; operation(stats === 1 ? 'initial-stat' : 'final-stat'); return { isFile: () => true, size: 3, mtime: new Date(0) } as never; }, read(_fd, buffer, offset, length, position) { return content.copy(buffer, offset, position, Math.min(content.length, position + length)); }, truncate() { operation('truncate'); }, fsync() { operation('fsync'); }, close() { operation('close'); } };
    expect(() => readCanonicalGrowingFileSnapshot('/owner/app.jsonl', z.unknown(), io)).toThrow(PublicationOutcomeUnknownError);
    expect(trace.at(-1)).toBe(stage);
  });

  it('rejects an initial over-cap stat without reading or mutating and closes once', () => {
    const trace: string[] = [];
    const io: CanonicalGrowingFileReadIo = {
      open() { trace.push('open'); return 1; },
      stat() { trace.push('stat'); return { isFile: () => true, size: 6 } as never; },
      read() { trace.push('read'); return 0; }, truncate() { trace.push('truncate'); }, fsync() { trace.push('fsync'); }, close() { trace.push('close'); },
    };
    expect(readCappedCanonicalGrowingFileSnapshot('/owner/status.jsonl', z.unknown(), 5, io)).toEqual({ kind: 'too-large', size: 6 });
    expect(trace).toEqual(['open', 'stat', 'close']);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY])('rejects invalid capped size %s before opening', (maximumBytes) => {
    let opens = 0;
    const io = { open() { opens += 1; return 1; } } as never;
    expect(() => readCappedCanonicalGrowingFileSnapshot('/owner/status.jsonl', z.unknown(), maximumBytes, io)).toThrow(/maximum byte count/);
    expect(opens).toBe(0);
  });

  it('uses only the maximum-plus-one proof buffer and advances forced short reads by actual bytes', () => {
    const source = Buffer.from([0xff, 1, 2, 3, 4, 5, 6, 7]);
    const requests: Array<{ offset: number; length: number; position: number }> = [];
    const returns = [2, 3, 1];
    let stats = 0;
    const trace: string[] = [];
    const io: CanonicalGrowingFileReadIo = {
      open() { trace.push('open'); return 1; },
      stat() { stats += 1; trace.push('stat'); return { isFile: () => true, size: 5, mtime: new Date(0) } as never; },
      read(_descriptor, buffer, offset, length, position) {
        expect(buffer.byteLength).toBe(6);
        expect(offset + length).toBeLessThanOrEqual(buffer.byteLength);
        requests.push({ offset, length, position }); trace.push('read');
        const count = returns.shift()!;
        source.copy(buffer, offset, position, position + count);
        return count;
      },
      truncate() { trace.push('truncate'); }, fsync() { trace.push('fsync'); }, close() { trace.push('close'); },
    };
    expect(readCappedCanonicalGrowingFileSnapshot('/owner/status.jsonl', z.unknown(), 5, io)).toEqual({ kind: 'too-large', size: 6 });
    expect(requests).toEqual([
      { offset: 0, length: 6, position: 0 },
      { offset: 2, length: 4, position: 2 },
      { offset: 5, length: 1, position: 5 },
    ]);
    expect(stats).toBe(1);
    expect(trace).toEqual(['open', 'stat', 'read', 'read', 'read', 'close']);
  });

  it('preserves capped pre-mutation failures and treats either too-large close failure as authoritative', () => {
    const readFailure = new Error('read failed');
    let closes = 0;
    const readIo: CanonicalGrowingFileReadIo = {
      open() { return 1; }, stat() { return { isFile: () => true, size: 1 } as never; },
      read() { throw readFailure; }, truncate() {}, fsync() {}, close() { closes += 1; throw new Error('close failed'); },
    };
    expect(() => readCappedCanonicalGrowingFileSnapshot('/owner/status.jsonl', z.unknown(), 5, readIo)).toThrow(readFailure);
    expect(closes).toBe(1);

    for (const initialSize of [6, 5]) {
      const closeFailure = new Error(`close failed at ${initialSize}`);
      let reads = 0; let closeCalls = 0;
      const tooLargeIo: CanonicalGrowingFileReadIo = {
        open() { return 1; }, stat() { return { isFile: () => true, size: initialSize } as never; },
        read(_descriptor, buffer, offset, length) { reads += 1; buffer.fill(0xff, offset, offset + length); return length; },
        truncate() { throw new Error('must not truncate'); }, fsync() { throw new Error('must not fsync'); },
        close() { closeCalls += 1; throw closeFailure; },
      };
      expect(() => readCappedCanonicalGrowingFileSnapshot('/owner/status.jsonl', z.unknown(), 5, tooLargeIo)).toThrow(closeFailure);
      expect(reads).toBe(initialSize > 5 ? 0 : 1);
      expect(closeCalls).toBe(1);
    }
  });

  it('takes a final stat only after capped EOF and retains canonical suffix handling', () => {
    const complete = Buffer.from('{"version":1,"type":"rows","rows":[{}]}\n');
    for (const source of [complete, Buffer.concat([complete, Buffer.from('partial')])]) {
      const trace: string[] = []; let stats = 0; let bytes = Buffer.from(source);
      const io: CanonicalGrowingFileReadIo = {
        open() { trace.push('open'); return 1; },
        stat() { stats += 1; trace.push(stats === 1 ? 'initial-stat' : 'final-stat'); return { isFile: () => true, size: bytes.byteLength, mtime: new Date(0) } as never; },
        read(_descriptor, buffer, offset, length, position) { trace.push(`read:${position}:${length}`); return bytes.copy(buffer, offset, position, Math.min(bytes.byteLength, position + length)); },
        truncate(_descriptor, length) { trace.push(`truncate:${length}`); bytes = bytes.subarray(0, length); },
        fsync() { trace.push('fsync'); }, close() { trace.push('close'); },
      };
      const result = readCappedCanonicalGrowingFileSnapshot('/owner/status.jsonl', z.unknown(), source.byteLength, io);
      expect(result.kind).toBe('found');
      if (result.kind !== 'found') throw new Error('Expected capped canonical snapshot.');
      expect(result.snapshot.bytes).toEqual(complete);
      expect(stats).toBe(2);
      expect(trace.at(-1)).toBe('close');
      expect(trace.filter((entry) => entry.startsWith('truncate'))).toHaveLength(source === complete ? 0 : 1);
    }
  });

  it('binds lifecycle-lock suffix writes and parent durability without post-error operations', () => {
    const root = mkdtempSync(join(tmpdir(), 'publication-lock-syscalls-'));
    try {
      const trace: string[] = []; let writes = 0; let opens = 0;
      const io: RuntimeLockPublicationIo = { open: ((_path: string, _flags: number) => { opens += 1; trace.push(opens === 1 ? 'lock-open' : 'parent-open'); return opens; }) as never, write: ((_fd: number, _bytes: Uint8Array, offset: number, length: number) => { trace.push(`write:${offset}`); writes += 1; if (writes === 1) throw zeroEintr; return writes === 2 ? 1 : length; }) as never, fsync(fd) { trace.push(fd === 1 ? 'file-fsync' : 'parent-fsync'); }, close(fd) { trace.push(fd === 1 ? 'file-close' : 'parent-close'); } };
      acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init', config: { readProcessStartIdentity: () => '1', publicationIo: io } });
      expect(trace.slice(0, 4)).toEqual(['lock-open', 'write:0', 'write:0', 'write:1']);
      expect(trace.slice(-3)).toEqual(['parent-open', 'parent-fsync', 'parent-close']);
      let laterWrites = 0;
      const laterEintr: RuntimeLockPublicationIo = { ...io, open: (() => 1) as never, write: ((_fd: number, _bytes: Uint8Array, _offset: number, length: number) => { laterWrites += 1; if (laterWrites === 1) return 1; throw zeroEintr; }) as never };
      expect(() => acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init', config: { lockFilePath: join(root, 'lock-later-eintr'), readProcessStartIdentity: () => '1', publicationIo: laterEintr } })).toThrow(PublicationOutcomeUnknownError);
      expect(laterWrites).toBe(2);
      for (const stage of ['write', 'file-fsync', 'file-close', 'parent-open', 'parent-fsync', 'parent-close'] as const) {
        const failedTrace: string[] = []; let failedOpens = 0;
        const failed: RuntimeLockPublicationIo = { open: ((_path: string, _flags: number) => { failedOpens += 1; const name = failedOpens === 1 ? 'lock-open' : 'parent-open'; failedTrace.push(name); if (name === stage) throw failure; return failedOpens; }) as never, write: ((_fd: number, _bytes: Uint8Array, _offset: number, length: number) => { failedTrace.push('write'); if (stage === 'write') throw unknownEintr; return length; }) as never, fsync(fd) { const name = fd === 1 ? 'file-fsync' : 'parent-fsync'; failedTrace.push(name); if (name === stage) throw failure; }, close(fd) { const name = fd === 1 ? 'file-close' : 'parent-close'; failedTrace.push(name); if (name === stage) throw failure; } };
        expect(() => acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init', config: { lockFilePath: join(root, `lock-${stage}`), readProcessStartIdentity: () => '1', publicationIo: failed } })).toThrow(PublicationOutcomeUnknownError);
        expect(failedTrace.at(-1)).toBe(stage);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
