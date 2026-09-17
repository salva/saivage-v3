import { describe, expect, it } from '@jest/globals';

import { createImmutableVersionFile, type ImmutableVersionFileIo } from '../../src/persistence/version-file.js';

describe('immutable version exact writes', () => {
  it('writes only the remaining suffix after a positive short write', () => {
    const trace: unknown[] = [];
    let writes = 0;
    const io: ImmutableVersionFileIo = {
      open: (() => 7) as ImmutableVersionFileIo['open'],
      write: ((descriptor: number, _bytes: Uint8Array, offset: number, length: number) => {
        trace.push(['write', descriptor, offset, length]);
        writes += 1;
        return writes === 1 ? 2 : length;
      }) as ImmutableVersionFileIo['write'],
      fsync: ((descriptor: number) => { trace.push(['fsync', descriptor]); }) as ImmutableVersionFileIo['fsync'],
      close: ((descriptor: number) => { trace.push(['close', descriptor]); }) as ImmutableVersionFileIo['close'],
    };

    createImmutableVersionFile('/card/versions/1-id.json', Buffer.from('abcd'), io);

    expect(trace).toEqual([
      ['write', 7, 0, 4],
      ['write', 7, 2, 2],
      ['fsync', 7],
      ['close', 7],
    ]);
  });

  const writeFailureCases: Array<[string, Error, boolean]> = [
    ['later EIO', Object.assign(new Error('later write failed'), { code: 'EIO' }), true],
    ['first ENOSPC', Object.assign(new Error('no space for write'), { code: 'ENOSPC' }), false],
  ];

  it.each(writeFailureCases)('preserves the exact %s object and stops before durability', (_name, failure, makeProgress) => {
    const trace: string[] = [];
    let writes = 0;
    const io: ImmutableVersionFileIo = {
      open: (() => 7) as ImmutableVersionFileIo['open'],
      write: ((_descriptor, _bytes, _offset, length) => {
        trace.push('write');
        writes += 1;
        if (makeProgress && writes === 1) return 1;
        throw failure;
      }) as ImmutableVersionFileIo['write'],
      fsync: (() => { trace.push('fsync'); }) as ImmutableVersionFileIo['fsync'],
      close: (() => { trace.push('close'); }) as ImmutableVersionFileIo['close'],
    };

    let thrown: unknown;
    try { createImmutableVersionFile('/card/versions/1-id.json', Buffer.from('ab'), io); }
    catch (error) { thrown = error; }

    expect(thrown).toBe(failure);
    expect(trace).toEqual(makeProgress ? ['write', 'write'] : ['write']);
  });

  it('keeps the path-bearing zero-progress error direct and stops before durability', () => {
    const trace: string[] = [];
    const io: ImmutableVersionFileIo = {
      open: (() => 7) as ImmutableVersionFileIo['open'],
      write: (() => { trace.push('write'); return 0; }) as ImmutableVersionFileIo['write'],
      fsync: (() => { trace.push('fsync'); }) as ImmutableVersionFileIo['fsync'],
      close: (() => { trace.push('close'); }) as ImmutableVersionFileIo['close'],
    };

    let thrown: unknown;
    try { createImmutableVersionFile('/card/versions/1-id.json', Buffer.from('a'), io); }
    catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Write made no progress for '/card/versions/1-id.json'.");
    expect(trace).toEqual(['write']);
  });
});
