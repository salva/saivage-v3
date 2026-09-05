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
import { writeAllExact } from './write-all-exact.js';

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
  writeAllExact(descriptor, bytes, io.write, () => new Error(`Write made no progress for '${temporaryPath}'.`));
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
