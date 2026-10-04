import { closeSync, constants, fsyncSync, linkSync, openSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';
import {
  replaceFile,
  type PublicationTemporaryIdFactory,
  type ReplacementFileIo,
} from './replace-file.js';

export interface HeadSlotIo {
  unlink: typeof unlinkSync;
  link: typeof linkSync;
}

/** The owner supplies established absence/current selection; this never probes either slot. */
export function publishHeadFile(
  current: string,
  previous: string,
  bytes: Uint8Array,
  mode: 'initial' | 'replacement',
  temporary?: PublicationTemporaryIdFactory,
  io?: ReplacementFileIo,
  slot: HeadSlotIo = { unlink: unlinkSync, link: linkSync },
): void {
  try {
    slot.unlink(previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (mode === 'replacement') slot.link(current, previous);
  // Namespace changes are not transactional. Durability failure permits no cleanup.
  try {
    const descriptor = (io?.open ?? openSync)(dirname(current), constants.O_RDONLY);
    (io?.fsync ?? fsyncSync)(descriptor);
    (io?.close ?? closeSync)(descriptor);
  } catch (error) {
    throw new PublicationOutcomeUnknownError(error);
  }
  replaceFile(current, bytes, temporary, io);
}
