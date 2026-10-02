import { constants } from 'node:fs';
import type { ReplacementFileIo } from '../../src/persistence/replace-file.js';

export const publicationPhases = ['temp-open', 'write', 'file-fsync', 'file-close', 'rename', 'parent-open', 'parent-fsync', 'parent-close'] as const;
export type PublicationFault = typeof publicationPhases[number] | 'zero-write' | 'short-write-error' | 'rename-effect-throw';

// A syscall trace, not a recovery path: no fixture inspection after failure.
export function publicationWitness(fault?: PublicationFault) {
  const trace: string[] = [];
  const opens: unknown[][] = [];
  const writes: { offset: number; length: number; bytes: Uint8Array }[] = [];
  const renames: string[][] = [];
  const failure = new Error(fault ?? 'unused failure');
  let written = 0;
  let renameEffect = false;
  const step = (phase: string) => { trace.push(phase); if (phase === fault) throw failure; };
  const io: ReplacementFileIo = {
    open: ((...args: unknown[]) => {
      opens.push(args);
      const directory = args[1] === constants.O_RDONLY;
      step(directory ? 'parent-open' : 'temp-open');
      return directory ? 2 : 1;
    }) as never,
    write: ((_fd: number, bytes: Uint8Array, offset: number, length: number) => {
      writes.push({ offset, length, bytes });
      step('write');
      if (fault === 'zero-write') return 0;
      if (fault === 'short-write-error' && written > 0) throw failure;
      const count = written++ === 0 ? 2 : length;
      return count;
    }) as never,
    fsync(fd) { step(fd === 1 ? 'file-fsync' : 'parent-fsync'); },
    close(fd) { step(fd === 1 ? 'file-close' : 'parent-close'); },
    rename(from, to) {
      renames.push([String(from), String(to)]);
      step('rename');
      renameEffect = true;
      if (fault === 'rename-effect-throw') throw failure;
    },
  };
  return { io, trace, opens, writes, renames, failure, renameEffect: () => renameEffect };
}
