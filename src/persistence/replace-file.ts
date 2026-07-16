import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type PublicationTemporaryIdFactory = () => string;

export function replacementTempPath(targetPath: string, temporaryId: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.${temporaryId}.saivage-tmp`);
}

export function replaceFile(
  targetPath: string,
  bytes: Uint8Array,
  publicationTemporaryId: PublicationTemporaryIdFactory = randomUUID,
): void {
  const parentPath = dirname(targetPath);
  mkdirSync(parentPath, { recursive: true });
  const temporaryPath = replacementTempPath(targetPath, publicationTemporaryId());
  const descriptor = openSync(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
  );
  let open = true;
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (written === 0) throw new Error(`Write made no progress for '${temporaryPath}'.`);
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    open = false;
    renameSync(temporaryPath, targetPath);
    const parentDescriptor = openSync(parentPath, constants.O_RDONLY);
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } catch (error) {
    if (open) closeSync(descriptor);
    throw error;
  }
}
