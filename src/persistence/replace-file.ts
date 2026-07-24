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
import { PublicationOutcomeUnknownError } from '../contracts/index.js';

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
  let offset = 0;
  while (offset < bytes.byteLength) {
    let written: number;
    try {
      written = io.write(descriptor, bytes, offset, bytes.byteLength - offset);
    } catch (error) {
      if (offset === 0 && (error as NodeJS.ErrnoException & { bytesWritten?: number }).code === 'EINTR' && (error as { bytesWritten?: number }).bytesWritten === 0) continue;
      throw error;
    }
    if (written === 0) throw new Error(`Write made no progress for '${temporaryPath}'.`);
    offset += written;
  }
  io.fsync(descriptor);
  io.close(descriptor);
  try {
    io.rename(temporaryPath, targetPath);
    const parentDescriptor = io.open(parentPath, constants.O_RDONLY);
    io.fsync(parentDescriptor);
    io.close(parentDescriptor);
  } catch {
    throw new PublicationOutcomeUnknownError();
  }
}
