import { describe, expect, it } from '@jest/globals';
import { constants } from 'node:fs';

import { createImmutableVersionFile, type ImmutableVersionFileIo } from '../../src/persistence/version-file.js';

describe('immutable version file publication', () => {
  it('opens the final path exactly once with exclusive-create flags and performs no rename', () => {
    const trace: unknown[] = [];
    let opens = 0;
    const io: ImmutableVersionFileIo = {
      open: ((path: string, flags: number) => { opens += 1; trace.push(['open', path, flags]); return 7; }) as ImmutableVersionFileIo['open'],
      write: ((descriptor: number, _bytes: Uint8Array, offset: number, length: number) => { trace.push(['write', descriptor, offset, length]); return length; }) as ImmutableVersionFileIo['write'],
      fsync: ((descriptor: number) => { trace.push(['fsync', descriptor]); }) as ImmutableVersionFileIo['fsync'],
      close: ((descriptor: number) => { trace.push(['close', descriptor]); }) as ImmutableVersionFileIo['close'],
    };
    createImmutableVersionFile('/card/versions/1-id.json', Buffer.from('abc'), io);
    expect(trace).toEqual([
      ['open', '/card/versions/1-id.json', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY],
      ['write', 7, 0, 3], ['fsync', 7], ['close', 7],
    ]);
    expect(opens).toBe(1);
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
