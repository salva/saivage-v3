import { closeSync, ftruncateSync, fsyncSync, openSync, readFileSync } from 'node:fs';

import { cleanupDurableReplacementTemporaries } from './durable-file-replacement.js';

export function restabilizeSingleFileReplacement(directoryPath: string, targetBasename: string): void {
  cleanupDurableReplacementTemporaries(directoryPath, [targetBasename]);
}

/** Discard only an interrupted final JSONL tail. Complete malformed rows remain for the strict reader to reject. */
export function discardIncompleteJsonlTail(path: string): void {
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] === 0x0a) return;
  const finalNewline = bytes.lastIndexOf(0x0a);
  const length = finalNewline < 0 ? 0 : finalNewline + 1;
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
