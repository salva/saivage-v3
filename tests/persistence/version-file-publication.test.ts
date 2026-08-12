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

  it('retries only a first proven-zero-byte EINTR', () => {
    let calls = 0;
    const io: ImmutableVersionFileIo = {
      open: (() => 7) as ImmutableVersionFileIo['open'],
      write: ((_descriptor, _bytes, _offset, length) => { calls += 1; if (calls === 1) throw Object.assign(new Error('interrupted'), { code: 'EINTR', bytesWritten: 0 }); return length; }) as ImmutableVersionFileIo['write'],
      fsync: () => undefined,
      close: () => undefined,
    };
    createImmutableVersionFile('/card/versions/1-id.json', Buffer.from('abc'), io);
    expect(calls).toBe(2);
  });
});
