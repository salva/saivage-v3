import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

type FaultPoint =
  | 'exclusive-create'
  | 'partial-write'
  | 'file-sync'
  | 'file-close'
  | 'rename'
  | 'directory-open'
  | 'directory-sync'
  | 'directory-close'
  | 'cleanup';

const fixedUuid = '12345678-1234-4234-8234-123456789abc';
let faultAt: FaultPoint | undefined;
let temporaryFd: number | undefined;
let directoryFd: number | undefined;
let observedTemporaryPath: string | undefined;
let partialWriteReturned = false;
let limitWriteSize: number | undefined;

function injectedFailure(point: FaultPoint): Error {
  return new Error(`injected ${point} failure`);
}

jest.unstable_mockModule('node:crypto', () => ({
  randomUUID: () => fixedUuid,
}));

jest.unstable_mockModule('node:fs', () => ({
  ...realFs,
  openSync: (path: realFs.PathLike, flags: realFs.OpenMode, mode?: realFs.Mode) => {
    if (flags === 'wx') {
      observedTemporaryPath = String(path);
      if (faultAt === 'exclusive-create') throw injectedFailure(faultAt);
      temporaryFd = realFs.openSync(path, flags, mode);
      return temporaryFd;
    }
    if (faultAt === 'directory-open') throw injectedFailure(faultAt);
    directoryFd = realFs.openSync(path, flags, mode);
    return directoryFd;
  },
  writeSync: (fd: number, bytes: Uint8Array, offset: number, length: number) => {
    if (faultAt === 'partial-write') {
      if (partialWriteReturned) throw injectedFailure(faultAt);
      partialWriteReturned = true;
      return realFs.writeSync(fd, bytes, offset, Math.min(2, length));
    }
    return realFs.writeSync(fd, bytes, offset, Math.min(limitWriteSize ?? length, length));
  },
  fsyncSync: (fd: number) => {
    if (fd === temporaryFd && faultAt === 'file-sync') throw injectedFailure(faultAt);
    if (fd === directoryFd && faultAt === 'directory-sync') throw injectedFailure(faultAt);
    return realFs.fsyncSync(fd);
  },
  closeSync: (fd: number) => {
    if (fd === temporaryFd && faultAt === 'file-close') {
      realFs.closeSync(fd);
      throw injectedFailure(faultAt);
    }
    if (fd === directoryFd && faultAt === 'directory-close') {
      realFs.closeSync(fd);
      throw injectedFailure(faultAt);
    }
    return realFs.closeSync(fd);
  },
  renameSync: (oldPath: realFs.PathLike, newPath: realFs.PathLike) => {
    if (faultAt === 'rename') throw injectedFailure(faultAt);
    return realFs.renameSync(oldPath, newPath);
  },
  unlinkSync: (path: realFs.PathLike) => {
    if (faultAt === 'cleanup') throw injectedFailure(faultAt);
    return realFs.unlinkSync(path);
  },
}));

const {
  cleanupDurableReplacementTemporaries,
  durablyReplaceFile,
  publishDirectory,
} = await import('../../src/persistence/durable-file-replacement.js');
const { IndeterminatePublicationError } = await import('../../src/persistence/errors.js');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-durable-replacement-'));
  faultAt = undefined;
  temporaryFd = undefined;
  directoryFd = undefined;
  observedTemporaryPath = undefined;
  partialWriteReturned = false;
  limitWriteSize = undefined;
});

afterEach(() => {
  realFs.rmSync(root, { recursive: true, force: true });
});

describe('durablyReplaceFile', () => {
  it('writes all bytes through short writes with a restrictive target-bound same-directory temporary', () => {
    const targetPath = join(root, 'card.version+1.json');
    limitWriteSize = 2;

    durablyReplaceFile(targetPath, Buffer.from('complete bytes'));

    expect(realFs.readFileSync(targetPath, 'utf8')).toBe('complete bytes');
    expect(dirname(observedTemporaryPath!)).toBe(root);
    expect(basename(observedTemporaryPath!)).toBe(`.card.version+1.json.saivage-write-${fixedUuid}.tmp`);
    expect(realFs.statSync(targetPath).mode & 0o777).toBe(0o600);
    expect(realFs.readdirSync(root)).toEqual(['card.version+1.json']);
  });

  it.each<FaultPoint>(['exclusive-create', 'partial-write', 'file-sync', 'file-close', 'rename'])(
    'preserves the old target and removes its own temporary after a %s failure',
    (point) => {
      const targetPath = join(root, 'index.json');
      realFs.writeFileSync(targetPath, 'old');
      faultAt = point;

      expect(() => durablyReplaceFile(targetPath, Buffer.from('new value'))).toThrow(`injected ${point} failure`);

      expect(realFs.readFileSync(targetPath, 'utf8')).toBe('old');
      expect(realFs.readdirSync(root)).toEqual(['index.json']);
    },
  );

  it.each<FaultPoint>(['directory-open', 'directory-sync', 'directory-close'])(
    'reports an indeterminate publication with complete new bytes after a %s failure',
    (point) => {
      const targetPath = join(root, 'index.json');
      realFs.writeFileSync(targetPath, 'old');
      faultAt = point;

      let thrown: unknown;
      try {
        durablyReplaceFile(targetPath, Buffer.from('new'));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(IndeterminatePublicationError);
      expect((thrown as Error).cause).toEqual(injectedFailure(point));
      expect(realFs.readFileSync(targetPath, 'utf8')).toBe('new');
      expect(realFs.readdirSync(root)).toEqual(['index.json']);
    },
  );

  it('does not remove a colliding temporary that this invocation did not create', () => {
    const targetPath = join(root, 'index.json');
    const collisionPath = join(root, `.index.json.saivage-write-${fixedUuid}.tmp`);
    realFs.writeFileSync(targetPath, 'old');
    realFs.writeFileSync(collisionPath, 'other invocation');

    expect(() => durablyReplaceFile(targetPath, Buffer.from('new'))).toThrow(/EEXIST/);

    expect(realFs.readFileSync(targetPath, 'utf8')).toBe('old');
    expect(realFs.readFileSync(collisionPath, 'utf8')).toBe('other invocation');
  });

  it('attaches cleanup failures without hiding the primary failure', () => {
    const targetPath = join(root, 'index.json');
    realFs.writeFileSync(targetPath, 'old');
    faultAt = 'rename';
    let thrown: (Error & { cleanupErrors?: unknown[] }) | undefined;
    try {
      faultAt = 'cleanup';
      limitWriteSize = 0;
      durablyReplaceFile(targetPath, Buffer.from('new'));
    } catch (error) {
      thrown = error as Error & { cleanupErrors?: unknown[] };
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).toMatch(/made no progress/);
    expect(thrown?.cleanupErrors).toHaveLength(1);
    expect((thrown?.cleanupErrors?.[0] as Error).message).toBe('injected cleanup failure');
  });

  it('requires an absolute target and an existing containing directory', () => {
    expect(() => durablyReplaceFile('relative.json', Buffer.from('x'))).toThrow(/absolute non-root path/);
    expect(() => durablyReplaceFile(join(root, 'missing', 'target.json'), Buffer.from('x'))).toThrow(/ENOENT/);
  });
});

describe('publishDirectory', () => {
  it('creates exactly one restrictive directory in an existing parent', () => {
    const directoryPath = join(root, 'versions');

    publishDirectory(directoryPath);

    expect(realFs.statSync(directoryPath).isDirectory()).toBe(true);
    expect(realFs.statSync(directoryPath).mode & 0o777).toBe(0o700);
  });

  it('reports synchronization failure without pretending the directory was not published', () => {
    const directoryPath = join(root, 'versions');
    faultAt = 'directory-sync';

    expect(() => publishDirectory(directoryPath)).toThrow('injected directory-sync failure');
    expect(realFs.statSync(directoryPath).isDirectory()).toBe(true);
  });
});

describe('cleanupDurableReplacementTemporaries', () => {
  it('removes only exact temporaries bound to owned target basenames', () => {
    const owned = `.index.json.saivage-write-${fixedUuid}.tmp`;
    const other = `.card.json.saivage-write-${fixedUuid}.tmp`;
    const generic = 'index.json.tmp';
    const malformedUuid = '.index.json.saivage-write-not-a-uuid.tmp';
    for (const name of [owned, other, generic, malformedUuid]) realFs.writeFileSync(join(root, name), name);

    cleanupDurableReplacementTemporaries(root, ['index.json']);

    expect(realFs.readdirSync(root).sort()).toEqual([generic, malformedUuid, other].sort());
  });

  it('rejects an owned symlink before removing any candidate', () => {
    const regular = `.index.json.saivage-write-${fixedUuid}.tmp`;
    const symlink = `.index.json.saivage-write-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp`;
    realFs.writeFileSync(join(root, regular), 'temporary');
    realFs.symlinkSync(join(root, regular), join(root, symlink));

    expect(() => cleanupDurableReplacementTemporaries(root, ['index.json'])).toThrow(/not a regular file/);
    expect(realFs.lstatSync(join(root, regular)).isFile()).toBe(true);
    expect(realFs.lstatSync(join(root, symlink)).isSymbolicLink()).toBe(true);
  });
});
