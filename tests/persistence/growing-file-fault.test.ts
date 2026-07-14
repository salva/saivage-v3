import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Fault = 'open' | 'write' | 'fsync' | 'close';
let fault: Fault | undefined;
let appendFd: number | undefined;
let writeCalls = 0;
let openCalls = 0;

jest.unstable_mockModule('node:fs', () => ({
  ...realFs,
  openSync: (path: realFs.PathLike, flags: realFs.OpenMode, mode?: realFs.Mode) => {
    if (typeof flags === 'number' && (flags & realFs.constants.O_APPEND) !== 0) {
      openCalls += 1;
      if (fault === 'open') throw new Error('injected open failure');
      appendFd = realFs.openSync(path, flags, mode);
      return appendFd;
    }
    return realFs.openSync(path, flags, mode);
  },
  writeSync: (fd: number, bytes: Uint8Array, offset: number, length: number) => {
    if (fd === appendFd) {
      writeCalls += 1;
      if (fault === 'write') {
        if (writeCalls === 1) return realFs.writeSync(fd, bytes, offset, Math.min(2, length));
        throw new Error('injected write failure');
      }
    }
    return realFs.writeSync(fd, bytes, offset, length);
  },
  fsyncSync: (fd: number) => {
    if (fd === appendFd && fault === 'fsync') throw new Error('injected fsync failure');
    return realFs.fsyncSync(fd);
  },
  closeSync: (fd: number) => {
    if (fd === appendFd && fault === 'close') {
      realFs.closeSync(fd); appendFd = undefined; throw new Error('injected close failure');
    }
    const result = realFs.closeSync(fd);
    if (fd === appendFd) appendFd = undefined;
    return result;
  },
}));

const { appendEnvelope } = await import('../../src/persistence/growing-file.js');
const { ApplicationPersistenceHealth, PersistenceMutationUnhealthyError } = await import('../../src/application/persistence-health.js');

let root: string;
let path: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-growing-fault-')); path = join(root, 'target.jsonl'); realFs.writeFileSync(path, '{"version":1,"type":"rows","rows":[{"id":"first"}]}\n'); fault = undefined; appendFd = undefined; writeCalls = 0; openCalls = 0; });
afterEach(() => realFs.rmSync(root, { recursive: true, force: true }));

describe('growing append uncertainty boundary', () => {
  it('keeps pre-write open failure nonterminal', () => {
    const health = new ApplicationPersistenceHealth(); fault = 'open';
    expect(() => appendEnvelope(path, Buffer.from('next\n'), health, 'append test')).toThrow(/open failure/);
    expect(health.snapshot()).toEqual({ state: 'healthy' });
  });

  for (const point of ['write', 'fsync', 'close'] as const) {
    it(`terminally reports ${point} failure and blocks later filesystem access`, () => {
      const health = new ApplicationPersistenceHealth(); fault = point;
      expect(() => appendEnvelope(path, Buffer.from('next\n'), health, 'append test')).toThrow(PersistenceMutationUnhealthyError);
      expect(health.snapshot()).toMatchObject({ state: 'mutation_unhealthy', diagnostic: { operation: 'append test', target: path } });
      const calls = openCalls; fault = undefined;
      expect(() => appendEnvelope(path, Buffer.from('later\n'), health, 'append later')).toThrow(PersistenceMutationUnhealthyError);
      expect(openCalls).toBe(calls);
    });
  }
});
