import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { z } from 'zod';

import { replaceFile, type PublicationTemporaryIdFactory, type ReplacementFileIo } from './replace-file.js';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';
import { writeAllExact } from './write-all-exact.js';

export interface GrowingFileIo {
  open: typeof openSync; stat: (descriptor: number) => Stats; write: typeof writeSync; fsync: typeof fsyncSync; close: typeof closeSync;
}
export interface CanonicalGrowingFileSnapshot<Row> {
  readonly bytes: Buffer;
  readonly rows: readonly Row[];
  readonly size: number;
  readonly modifiedAt: string;
}
export interface CanonicalReadInstrumentation { readonly onRead: (path: string) => void }
export interface GrowingFileRowCheckpoint { readonly rowOrdinal: number }
const growingFileIo: GrowingFileIo = { open: openSync, stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync };
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;

const envelopeSchema = z.object({
  version: z.literal(1),
  type: z.literal('rows'),
  rows: z.array(z.unknown()).min(1),
}).strict();

export type GrowingEnvelope<Row> = Readonly<{ version: 1; type: 'rows'; rows: readonly Row[] }>;
export type PreparedGrowingEnvelope<Row> = Readonly<{ rows: readonly Row[]; bytes: Buffer }>;

export function prepareGrowingEnvelope<Row>(rows: readonly unknown[], rowSchema: z.ZodType<Row>): PreparedGrowingEnvelope<Row> {
  const parsedRows = rows.map((row) => rowSchema.parse(row));
  const envelope = envelopeSchema.parse({ version: 1, type: 'rows', rows: parsedRows });
  return Object.freeze({
    rows: Object.freeze(parsedRows),
    bytes: Buffer.from(`${JSON.stringify(envelope)}\n`),
  });
}

export function serializeGrowingEnvelope<Row>(rows: readonly unknown[], rowSchema: z.ZodType<Row>): Buffer {
  return prepareGrowingEnvelope(rows, rowSchema).bytes;
}

function parseGrowingFile<Row>(path: string, bytes: Buffer, rowSchema: z.ZodType<Row>): Row[] {
  if (bytes.byteLength === 0) throw new Error(`Growing file '${path}' is empty.`);
  if (bytes.at(-1) !== 0x0a) throw new Error(`Growing file '${path}' has an incomplete final envelope.`);
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) {
    throw new Error(`Growing file '${path}' is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
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

function readAt(read: typeof readSync, descriptor: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  const bytesRead = read(descriptor, buffer, 0, length, position);
  if (bytesRead < 0 || bytesRead > length) throw new Error(`Canonical growing-file read returned invalid byte count ${bytesRead}.`);
  return buffer.subarray(0, bytesRead);
}

function readAll(descriptor: number): Buffer {
  const chunks: Buffer[] = [];
  let position = 0;
  while (true) {
    const chunk = readAt(readSync, descriptor, position, DEFAULT_READ_CHUNK_BYTES);
    if (chunk.byteLength === 0) break;
    chunks.push(chunk);
    position += chunk.byteLength;
  }
  return Buffer.concat(chunks);
}

export function readStrictCanonicalGrowingFile<Row>(path: string, rowSchema: z.ZodType<Row>, instrumentation?: CanonicalReadInstrumentation): Row[] {
  instrumentation?.onRead(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`Canonical growing file '${path}' must be a regular file.`);
    return parseGrowingFile(path, readAll(descriptor), rowSchema);
  } finally { closeSync(descriptor); }
}

export function publishFirstEnvelope(
  target: string,
  bytes: Buffer,
  publicationTemporaryId?: PublicationTemporaryIdFactory,
  replacementIo?: ReplacementFileIo,
): void {
  try { lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      replaceFile(target, bytes, publicationTemporaryId, replacementIo);
      return;
    }
    throw error;
  }
  throw new Error(`Growing file '${target}' is already published.`);
}

export type AppendEnvelopeResult =
  | { readonly kind: 'appended' }
  | { readonly kind: 'missing' };

export function appendEnvelope(
  target: string,
  bytes: Buffer,
  io: GrowingFileIo = growingFileIo,
): AppendEnvelopeResult {
  let fd: number;
  try {
    fd = io.open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }

  try {
    if (!io.stat(fd).isFile()) throw new Error(`Growing-file append target '${target}' must be a regular file.`);
  } catch (error) { try { io.close(fd); } catch { /* pre-publication close does not displace admission failure */ } throw error; }
  try {
    writeAllExact(fd, bytes, io.write, () => new Error('zero progress'));
    io.fsync(fd);
    io.close(fd);
  } catch { throw new PublicationOutcomeUnknownError(); }
  return { kind: 'appended' };
}
