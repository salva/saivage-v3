import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type PublicationTemporaryIdFactory = () => string;
export interface ReplacementFileIo {
  open: typeof openSync; write: typeof writeSync; fsync: typeof fsyncSync; close: typeof closeSync; rename: typeof renameSync;
}
const replacementFileIo: ReplacementFileIo = { open: openSync, write: writeSync, fsync: fsyncSync, close: closeSync, rename: renameSync };

export function replacementTempPath(targetPath: string, temporaryId: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.${temporaryId}.saivage-tmp`);
}

export function replaceFile(
  targetPath: string,
  bytes: Uint8Array,
  publicationTemporaryId: PublicationTemporaryIdFactory = randomUUID,
  io: ReplacementFileIo = replacementFileIo,
): void {
  const parentPath = dirname(targetPath);
  const temporaryPath = replacementTempPath(targetPath, publicationTemporaryId());
  const descriptor = io.open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
  );
  let open = true;
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = io.write(descriptor, bytes, offset, bytes.byteLength - offset);
      if (written === 0) throw new Error(`Write made no progress for '${temporaryPath}'.`);
      offset += written;
    }
    io.fsync(descriptor);
    io.close(descriptor);
    open = false;
    io.rename(temporaryPath, targetPath);
    const parentDescriptor = io.open(parentPath, constants.O_RDONLY);
    try {
      io.fsync(parentDescriptor);
    } finally {
      io.close(parentDescriptor);
    }
  } catch (error) {
    if (open) io.close(descriptor);
    throw error;
  }
}
