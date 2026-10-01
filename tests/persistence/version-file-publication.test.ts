import { describe, expect, it } from '@jest/globals';
import { constants } from 'node:fs';

import { createImmutableVersionFile, type ImmutableVersionFileIo } from '../../src/persistence/version-file.js';

describe('immutable version file publication', () => {
  it('opens the final path exactly once with exclusive-create flags and performs no rename', () => {
    const trace: unknown[] = [];
    let opens = 0;
    const io: ImmutableVersionFileIo = {
      open: ((path: string, flags: number) => { opens += 1; trace.push(['open', path, flags]); return opens === 1 ? 7 : 8; }) as ImmutableVersionFileIo['open'],
      write: ((descriptor: number, _bytes: Uint8Array, offset: number, length: number) => { trace.push(['write', descriptor, offset, length]); return length; }) as ImmutableVersionFileIo['write'],
      fsync: ((descriptor: number) => { trace.push(['fsync', descriptor]); }) as ImmutableVersionFileIo['fsync'],
      close: ((descriptor: number) => { trace.push(['close', descriptor]); }) as ImmutableVersionFileIo['close'],
    };
    createImmutableVersionFile('/card/versions/1-id.json', Buffer.from('abc'), io);
    expect(trace).toEqual([
      ['open', '/card/versions/1-id.json', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY],
      ['write', 7, 0, 3], ['fsync', 7], ['close', 7],
      ['open', '/card/versions', constants.O_RDONLY], ['fsync', 8], ['close', 8],
    ]);
    expect(opens).toBe(2);
  });

  it.each(['file-open', 'write', 'file-fsync', 'file-close', 'parent-open', 'parent-fsync', 'parent-close'])('preserves %s error identity with no following operation', (phase) => {
    const trace: string[] = []; const failure = new Error(phase); let opens = 0;
    const op = (name: string) => { trace.push(name); if (name === phase) throw failure; };
    const io: ImmutableVersionFileIo = {
      open() { opens += 1; op(opens === 1 ? 'file-open' : 'parent-open'); return opens; },
      write: ((_fd, _bytes, _offset, length) => { op('write'); return length; }) as ImmutableVersionFileIo['write'],
      fsync(fd) { op(fd === 1 ? 'file-fsync' : 'parent-fsync'); }, close(fd) { op(fd === 1 ? 'file-close' : 'parent-close'); },
    };
    let thrown: unknown; try { createImmutableVersionFile('/card/versions/1.jsonl', Buffer.from('x'), io); } catch (error) { thrown = error; }
    expect(thrown).toBe(failure);
    expect(trace).toEqual(['file-open', 'write', 'file-fsync', 'file-close', 'parent-open', 'parent-fsync', 'parent-close'].slice(0, ['file-open', 'write', 'file-fsync', 'file-close', 'parent-open', 'parent-fsync', 'parent-close'].indexOf(phase) + 1));
  });

  it('propagates the exact first-write error without durability operations', () => {
    const failure = Object.assign(new Error('version write failed'), { code: 'EIO' });
    const trace: string[] = [];
    const io: ImmutableVersionFileIo = {
      open: (() => 7) as ImmutableVersionFileIo['open'],
      write: (() => { trace.push('write'); throw failure; }) as ImmutableVersionFileIo['write'],
      fsync: (() => { trace.push('fsync'); }) as ImmutableVersionFileIo['fsync'],
      close: (() => { trace.push('close'); }) as ImmutableVersionFileIo['close'],
    };
    let thrown: unknown;
    try { createImmutableVersionFile('/card/versions/1-id.json', Buffer.from('abc'), io); }
    catch (error) { thrown = error; }
    expect(thrown).toBe(failure);
    expect(trace).toEqual(['write']);
  });
});
