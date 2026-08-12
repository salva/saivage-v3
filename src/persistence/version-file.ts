import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';

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
  let offset = 0;
  while (offset < bytes.byteLength) {
    let written: number;
    try {
      written = io.write(descriptor, bytes, offset, bytes.byteLength - offset);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { bytesWritten?: number };
      if (offset === 0 && failure.code === 'EINTR' && failure.bytesWritten === 0) continue;
      throw error;
    }
    if (written === 0) throw new Error(`Write made no progress for '${path}'.`);
    offset += written;
  }
  io.fsync(descriptor);
  io.close(descriptor);
}

export function serializeStrictJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}
