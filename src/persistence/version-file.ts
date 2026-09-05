import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import { writeAllExact } from './write-all-exact.js';

export interface ImmutableVersionFileIo {
  open: typeof openSync;
  write: typeof writeSync;
  fsync: typeof fsyncSync;
  close: typeof closeSync;
}

const immutableVersionFileIo: ImmutableVersionFileIo = {
  open: openSync,
  write: writeSync,
  fsync: fsyncSync,
  close: closeSync,
};

export function createImmutableVersionFile(path: string, bytes: Uint8Array, io: ImmutableVersionFileIo = immutableVersionFileIo): void {
  const descriptor = io.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  writeAllExact(descriptor, bytes, io.write, () => new Error(`Write made no progress for '${path}'.`));
  io.fsync(descriptor);
  io.close(descriptor);
}

export function serializeStrictJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}
