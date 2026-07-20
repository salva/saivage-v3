import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { z } from 'zod';

import { replaceFile, type PublicationTemporaryIdFactory, type ReplacementFileIo } from './replace-file.js';

export interface GrowingFileIo {
  open: typeof openSync; write: typeof writeSync; fsync: typeof fsyncSync; truncate: typeof ftruncateSync; close: typeof closeSync;
}
export interface CanonicalGrowingFileReadIo {
  read: (descriptor: number) => Buffer;
  open: (path: string, flags: number) => number;
  stat: (descriptor: number) => Stats;
  fsync: (descriptor: number) => void;
  truncate: (descriptor: number, length: number) => void;
  close: (descriptor: number) => void;
}
export interface CanonicalGrowingFileSnapshot<Row> {
  readonly bytes: Buffer;
  readonly rows: readonly Row[];
  readonly size: number;
  readonly modifiedAt: string;
}
export interface CanonicalReadInstrumentation { readonly onRead: (path: string) => void }
const growingFileIo: GrowingFileIo = { open: openSync, write: writeSync, fsync: fsyncSync, truncate: ftruncateSync, close: closeSync };
const canonicalGrowingFileReadIo: CanonicalGrowingFileReadIo = { read: readFileSync, open: openSync, stat: fstatSync, fsync: fsyncSync, truncate: ftruncateSync, close: closeSync };

const envelopeSchema = z.object({
  version: z.literal(1),
  type: z.literal('rows'),
  rows: z.array(z.unknown()).min(1),
}).strict();

export type GrowingEnvelope<Row> = Readonly<{ version: 1; type: 'rows'; rows: readonly Row[] }>;

export function serializeGrowingEnvelope<Row>(rows: readonly Row[], rowSchema: z.ZodType<Row>): Buffer {
  const parsedRows = rows.map((row) => rowSchema.parse(row));
  const envelope = envelopeSchema.parse({ version: 1, type: 'rows', rows: parsedRows });
  return Buffer.from(`${JSON.stringify(envelope)}\n`);
}

export function parseGrowingFile<Row>(path: string, content: string, rowSchema: z.ZodType<Row>): Row[] {
  if (content.length === 0) throw new Error(`Growing file '${path}' is empty.`);
  if (!content.endsWith('\n')) throw new Error(`Growing file '${path}' has an incomplete final envelope.`);
  const rows: Row[] = [];
  const lines = content.split('\n');
  lines.pop();
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) throw new Error(`Growing file '${path}' envelope ${index + 1} is empty.`);
    try {
      const envelope = envelopeSchema.parse(JSON.parse(line));
      rows.push(...envelope.rows.map((row) => rowSchema.parse(row)));
    } catch (error) {
      throw new Error(`Growing file '${path}' envelope ${index + 1} is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return rows;
}

export function readCanonicalGrowingFileSnapshot<Row>(
  path: string,
  rowSchema: z.ZodType<Row>,
  io: CanonicalGrowingFileReadIo = canonicalGrowingFileReadIo,
  instrumentation?: CanonicalReadInstrumentation,
): CanonicalGrowingFileSnapshot<Row> {
  const descriptor = io.open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = io.stat(descriptor);
    if (!initial.isFile()) throw new Error(`Canonical growing file '${path}' must be a regular file.`);
    instrumentation?.onRead(path);
    let bytes = io.read(descriptor);
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) {
      const finalNewline = bytes.lastIndexOf(0x0a);
      const canonicalLength = finalNewline < 0 ? 0 : finalNewline + 1;
      io.truncate(descriptor, canonicalLength);
      io.fsync(descriptor);
      bytes = bytes.subarray(0, canonicalLength);
    }
    const rows = parseGrowingFile(path, bytes.toString('utf8'), rowSchema);
    const final = io.stat(descriptor);
    return Object.freeze({ bytes, rows: Object.freeze(rows), size: final.size, modifiedAt: final.mtime.toISOString() });
  } finally {
    io.close(descriptor);
  }
}

export function readCanonicalGrowingFile<Row>(path: string, rowSchema: z.ZodType<Row>, io?: CanonicalGrowingFileReadIo, instrumentation?: CanonicalReadInstrumentation): Row[] {
  return [...readCanonicalGrowingFileSnapshot(path, rowSchema, io, instrumentation).rows];
}

export function publishFirstEnvelope(
  target: string,
  bytes: Buffer,
  publicationTemporaryId?: PublicationTemporaryIdFactory,
  replacementIo?: ReplacementFileIo,
): void {
  try { closeSync(openSync(target, constants.O_RDONLY)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      replaceFile(target, bytes, publicationTemporaryId, replacementIo);
      return;
    }
    throw error;
  }
  throw new Error(`Growing file '${target}' is already published.`);
}

export function appendEnvelope(
  target: string,
  bytes: Buffer,
  io: GrowingFileIo = growingFileIo,
): void {
  let fd: number;
  try {
    fd = io.open(target, constants.O_WRONLY | constants.O_APPEND);
  } catch (error) {
    throw error;
  }

  let failure: unknown;
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = io.write(fd, bytes, offset, bytes.byteLength - offset);
      if (written === 0) throw new Error(`Growing-file append made no progress at '${target}'.`);
      offset += written;
    }
    io.fsync(fd);
  } catch (error) {
    failure = error;
  }
  try {
    io.close(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure;
  }
}
