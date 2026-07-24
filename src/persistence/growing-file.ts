import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { z } from 'zod';

import { replaceFile, type PublicationTemporaryIdFactory, type ReplacementFileIo } from './replace-file.js';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';

export interface GrowingFileIo {
  open: typeof openSync; stat: (descriptor: number) => Stats; write: typeof writeSync; fsync: typeof fsyncSync; close: typeof closeSync;
}
export interface CanonicalGrowingFileReadIo {
  read: (descriptor: number, buffer: Buffer, offset: number, length: number, position: number) => number;
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
export interface GrowingFileRowCheckpoint { readonly lineStart: number; readonly lineEnd: number; readonly rowOrdinal: number }
export interface GrowingFileReplay<Row> {
  readonly replayRow: (checkpoint: GrowingFileRowCheckpoint) => Row;
  readonly replayRows: (checkpoints: readonly GrowingFileRowCheckpoint[]) => readonly Row[];
}
export interface CanonicalGrowingFileFoldResult<State> {
  readonly state: State;
  readonly rowCount: number;
  readonly canonicalBytesRead: number;
  readonly replayBytesRead: number;
}
export interface CanonicalGrowingFileFoldInstrumentation {
  readonly onReadChunk?: (position: number, bytes: number, phase: 'classify' | 'parse' | 'replay') => void;
  readonly onEnvelope?: (lineStart: number, lineEnd: number, bytes: number) => void;
}
export interface CanonicalGrowingFileFirstEnvelope<Row> {
  readonly rows: readonly Row[];
  readonly checkpoints: readonly GrowingFileRowCheckpoint[];
  readonly bytesRead: number;
}
const growingFileIo: GrowingFileIo = { open: openSync, stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync };
const canonicalGrowingFileReadIo: CanonicalGrowingFileReadIo = { read: readSync, open: openSync, stat: fstatSync, fsync: fsyncSync, truncate: ftruncateSync, close: closeSync };
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

function readAt(io: CanonicalGrowingFileReadIo, descriptor: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  const bytesRead = io.read(descriptor, buffer, 0, length, position);
  if (bytesRead < 0 || bytesRead > length) throw new Error(`Canonical growing-file read returned invalid byte count ${bytesRead}.`);
  return buffer.subarray(0, bytesRead);
}

function readAll(io: CanonicalGrowingFileReadIo, descriptor: number): Buffer {
  const chunks: Buffer[] = [];
  let position = 0;
  while (true) {
    const chunk = readAt(io, descriptor, position, DEFAULT_READ_CHUNK_BYTES);
    if (chunk.byteLength === 0) break;
    chunks.push(chunk);
    position += chunk.byteLength;
  }
  return Buffer.concat(chunks);
}

function parseEnvelopeBytes<Row>(path: string, lineNumber: number, bytes: Buffer, rowSchema: z.ZodType<Row>): Row[] {
  if (bytes.byteLength === 0) throw new Error(`Growing file '${path}' envelope ${lineNumber} is empty.`);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const envelope = envelopeSchema.parse(JSON.parse(text));
    return envelope.rows.map((row) => rowSchema.parse(row));
  } catch (error) {
    throw new Error(`Growing file '${path}' envelope ${lineNumber} is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function closeAfterOrdinaryFailure(io: CanonicalGrowingFileReadIo, descriptor: number, error: unknown): never {
  try { io.close(descriptor); } catch { /* the ordinary operation failure remains authoritative */ }
  throw error;
}

function closeAfterSuccess(io: CanonicalGrowingFileReadIo, descriptor: number): void { io.close(descriptor); }

function truncateIdentifiableSuffix(io: CanonicalGrowingFileReadIo, descriptor: number, canonicalLength: number): void {
  try { io.truncate(descriptor, canonicalLength); } catch { throw new PublicationOutcomeUnknownError(); }
  try { io.fsync(descriptor); } catch { throw new PublicationOutcomeUnknownError(); }
}

function classifyCanonicalLength(
  descriptor: number,
  io: CanonicalGrowingFileReadIo,
  chunkBytes: number,
  instrumentation?: CanonicalGrowingFileFoldInstrumentation,
): { canonicalLength: number; physicalLength: number } {
  let position = 0;
  let lastNewline = -1;
  while (true) {
    const chunk = readAt(io, descriptor, position, chunkBytes);
    instrumentation?.onReadChunk?.(position, chunk.byteLength, 'classify');
    if (chunk.byteLength === 0) return { canonicalLength: lastNewline + 1, physicalLength: position };
    const localNewline = chunk.lastIndexOf(0x0a);
    if (localNewline >= 0) lastNewline = position + localNewline;
    position += chunk.byteLength;
  }
}

function parseCanonicalRange<Row>(args: {
  path: string;
  descriptor: number;
  canonicalLength: number;
  rowSchema: z.ZodType<Row>;
  io: CanonicalGrowingFileReadIo;
  chunkBytes: number;
  instrumentation?: CanonicalGrowingFileFoldInstrumentation;
  consume: (row: Row, checkpoint: GrowingFileRowCheckpoint, replay: GrowingFileReplay<Row>) => void;
}): { rowCount: number; replayBytesRead: number } {
  let position = 0;
  let lineStart = 0;
  let lineNumber = 0;
  let parts: Buffer[] = [];
  let replayBytesRead = 0;
  const replayRows = (checkpoints: readonly GrowingFileRowCheckpoint[]): readonly Row[] => {
    const envelopes = new Map<string, Row[]>();
    return checkpoints.map((checkpoint) => {
      const key = `${checkpoint.lineStart}:${checkpoint.lineEnd}`;
      let rows = envelopes.get(key);
      if (!rows) {
        const length = checkpoint.lineEnd - checkpoint.lineStart;
        const line = readAt(args.io, args.descriptor, checkpoint.lineStart, length);
        args.instrumentation?.onReadChunk?.(checkpoint.lineStart, line.byteLength, 'replay');
        replayBytesRead += line.byteLength;
        if (line.byteLength !== length || line.at(-1) !== 0x0a) throw new Error(`Growing file '${args.path}' replay checkpoint is not a complete envelope.`);
        rows = parseEnvelopeBytes(args.path, 0, line.subarray(0, -1), args.rowSchema);
        envelopes.set(key, rows);
      }
      const row = rows[checkpoint.rowOrdinal];
      if (row === undefined) throw new Error(`Growing file '${args.path}' replay checkpoint row ordinal is invalid.`);
      return row;
    });
  };
  const replayRow = (checkpoint: GrowingFileRowCheckpoint): Row => replayRows([checkpoint])[0]!;
  let rowCount = 0;
  while (position < args.canonicalLength) {
    const chunk = readAt(args.io, args.descriptor, position, Math.min(args.chunkBytes, args.canonicalLength - position));
    args.instrumentation?.onReadChunk?.(position, chunk.byteLength, 'parse');
    if (chunk.byteLength === 0) throw new Error(`Growing file '${args.path}' changed while its opened descriptor was being read.`);
    let consumed = 0;
    while (consumed < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, consumed);
      if (newline < 0) { parts.push(chunk.subarray(consumed)); break; }
      parts.push(chunk.subarray(consumed, newline));
      const lineEnd = position + newline + 1;
      const line = Buffer.concat(parts);
      parts = [];
      lineNumber += 1;
      args.instrumentation?.onEnvelope?.(lineStart, lineEnd, line.byteLength);
      const rows = parseEnvelopeBytes(args.path, lineNumber, line, args.rowSchema);
      rows.forEach((row, rowOrdinal) => {
        args.consume(row, Object.freeze({ lineStart, lineEnd, rowOrdinal }), { replayRow, replayRows });
        rowCount += 1;
      });
      lineStart = lineEnd;
      consumed = newline + 1;
    }
    position += chunk.byteLength;
  }
  if (parts.length > 0) throw new Error(`Growing file '${args.path}' has an incomplete final envelope.`);
  return { rowCount, replayBytesRead };
}

export function foldCanonicalGrowingFileRows<Row, State>(args: {
  path: string;
  rowSchema: z.ZodType<Row>;
  logicalId: (row: Row) => string;
  initialState: State;
  reduce: (state: State, row: Row, checkpoint: GrowingFileRowCheckpoint, replay: GrowingFileReplay<Row>) => State;
  io?: CanonicalGrowingFileReadIo;
  chunkBytes?: number;
  instrumentation?: CanonicalGrowingFileFoldInstrumentation;
}): CanonicalGrowingFileFoldResult<State> {
  const io = args.io ?? canonicalGrowingFileReadIo;
  const chunkBytes = args.chunkBytes ?? DEFAULT_READ_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Growing-file fold chunk size must be a positive safe integer.');
  const descriptor = io.open(args.path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!io.stat(descriptor).isFile()) throw new Error(`Canonical growing file '${args.path}' must be a regular file.`);
  } catch (error) { return closeAfterOrdinaryFailure(io, descriptor, error); }

  let lengths: { canonicalLength: number; physicalLength: number };
  try { lengths = classifyCanonicalLength(descriptor, io, chunkBytes, args.instrumentation); }
  catch (error) { return closeAfterOrdinaryFailure(io, descriptor, error); }
  if (lengths.canonicalLength !== lengths.physicalLength) truncateIdentifiableSuffix(io, descriptor, lengths.canonicalLength);

  let state = args.initialState;
  const ids = new Set<string>();
  let parsed: { rowCount: number; replayBytesRead: number };
  let descriptorOwned = true;
  try {
    if (lengths.canonicalLength === 0) throw new Error(`Growing file '${args.path}' is empty.`);
    parsed = parseCanonicalRange({ ...args, descriptor, canonicalLength: lengths.canonicalLength, io, chunkBytes, consume(row, checkpoint, replay) {
      const id = args.logicalId(row);
      if (ids.has(id)) throw new Error(`Growing file '${args.path}' contains duplicate logical id '${id}'.`);
      ids.add(id);
      state = args.reduce(state, row, checkpoint, replay);
    } });
    descriptorOwned = false;
    closeAfterSuccess(io, descriptor);
  } catch (error) { if (descriptorOwned) return closeAfterOrdinaryFailure(io, descriptor, error); throw error; }
  return Object.freeze({ state, rowCount: parsed.rowCount, canonicalBytesRead: lengths.canonicalLength * 2, replayBytesRead: parsed.replayBytesRead });
}

export function readCanonicalGrowingFileFirstEnvelope<Row>(
  path: string,
  rowSchema: z.ZodType<Row>,
  io: CanonicalGrowingFileReadIo = canonicalGrowingFileReadIo,
  chunkBytes = DEFAULT_READ_CHUNK_BYTES,
  instrumentation?: CanonicalGrowingFileFoldInstrumentation,
): CanonicalGrowingFileFirstEnvelope<Row> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Growing-file first-envelope chunk size must be a positive safe integer.');
  const descriptor = io.open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!io.stat(descriptor).isFile()) throw new Error(`Canonical growing file '${path}' must be a regular file.`); }
  catch (error) { return closeAfterOrdinaryFailure(io, descriptor, error); }
  let position = 0;
  let parts: Buffer[] = [];
  let firstLine: { bytes: Buffer; lineEnd: number } | null = null;
  try {
    while (true) {
      const chunk = readAt(io, descriptor, position, 1);
      instrumentation?.onReadChunk?.(position, chunk.byteLength, 'classify');
      if (chunk.byteLength === 0) {
        break;
      }
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) { parts.push(chunk); position += chunk.byteLength; continue; }
      parts.push(chunk.subarray(0, newline));
      const lineEnd = position + newline + 1;
      firstLine = { bytes: Buffer.concat(parts), lineEnd };
      break;
    }
  } catch (error) { return closeAfterOrdinaryFailure(io, descriptor, error); }
  if (firstLine === null) truncateIdentifiableSuffix(io, descriptor, 0);
  let descriptorOwned = true;
  try {
    if (firstLine === null) throw new Error(`Growing file '${path}' is empty.`);
    const rows = parseEnvelopeBytes(path, 1, firstLine.bytes, rowSchema);
    const checkpoints = rows.map((_row, rowOrdinal) => Object.freeze({ lineStart: 0, lineEnd: firstLine.lineEnd, rowOrdinal }));
    descriptorOwned = false;
    closeAfterSuccess(io, descriptor);
    return Object.freeze({ rows: Object.freeze(rows), checkpoints: Object.freeze(checkpoints), bytesRead: firstLine.lineEnd });
  } catch (error) { if (descriptorOwned) return closeAfterOrdinaryFailure(io, descriptor, error); throw error; }
}

export function readCanonicalGrowingFileSnapshot<Row>(
  path: string,
  rowSchema: z.ZodType<Row>,
  io: CanonicalGrowingFileReadIo = canonicalGrowingFileReadIo,
  instrumentation?: CanonicalReadInstrumentation,
): CanonicalGrowingFileSnapshot<Row> {
  const descriptor = io.open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let descriptorOwned = true;
  const close = (): void => { descriptorOwned = false; io.close(descriptor); };
  let bytes: Buffer;
  try {
    const initial = io.stat(descriptor);
    if (!initial.isFile()) throw new Error(`Canonical growing file '${path}' must be a regular file.`);
    instrumentation?.onRead(path);
    bytes = readAll(io, descriptor);
  } catch (error) {
    if (descriptorOwned) { try { close(); } catch { /* pre-truncation failure remains authoritative */ } }
    throw error;
  }
  if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) {
    const finalNewline = bytes.lastIndexOf(0x0a);
    const canonicalLength = finalNewline < 0 ? 0 : finalNewline + 1;
    let final: Stats;
    try {
      io.truncate(descriptor, canonicalLength);
      io.fsync(descriptor);
      bytes = bytes.subarray(0, canonicalLength);
      final = io.stat(descriptor);
      close();
    } catch { throw new PublicationOutcomeUnknownError(); }
    const rows = parseGrowingFile(path, bytes.toString('utf8'), rowSchema);
    return Object.freeze({ bytes, rows: Object.freeze(rows), size: final.size, modifiedAt: final.mtime.toISOString() });
  }
  try {
    const rows = parseGrowingFile(path, bytes.toString('utf8'), rowSchema);
    const final = io.stat(descriptor);
    close();
    return Object.freeze({ bytes, rows: Object.freeze(rows), size: final.size, modifiedAt: final.mtime.toISOString() });
  } catch (error) {
    if (descriptorOwned) { try { close(); } catch { /* pre-truncation failure remains authoritative */ } }
    throw error;
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
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      let written: number;
      try { written = io.write(fd, bytes, offset, bytes.byteLength - offset); }
      catch (error) {
        if (offset === 0 && (error as NodeJS.ErrnoException & { bytesWritten?: number }).code === 'EINTR' && (error as { bytesWritten?: number }).bytesWritten === 0) continue;
        throw error;
      }
      if (written === 0) throw new Error('zero progress');
      offset += written;
    }
    io.fsync(fd);
    io.close(fd);
  } catch { throw new PublicationOutcomeUnknownError(); }
  return { kind: 'appended' };
}
