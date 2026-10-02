import {
  constants,
  closeSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { z } from 'zod';

import {
  replaceFile,
  type PublicationTemporaryIdFactory,
  type ReplacementFileIo,
} from './replace-file.js';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';
import { writeAllExact } from './write-all-exact.js';

export interface GrowingFileIo {
  open: typeof openSync;
  write: typeof writeSync;
  fsync: typeof fsyncSync;
  close: typeof closeSync;
}
export interface GrowingFileTruncationIo {
  open: typeof openSync;
  ftruncate: typeof ftruncateSync;
  fsync: typeof fsyncSync;
  close: typeof closeSync;
}
export interface CanonicalReadInstrumentation {
  readonly onRead: (path: string) => void;
}
const growingFileIo: GrowingFileIo = {
  open: openSync,
  write: writeSync,
  fsync: fsyncSync,
  close: closeSync,
};
const growingFileTruncationIo: GrowingFileTruncationIo = {
  open: openSync,
  ftruncate: ftruncateSync,
  fsync: fsyncSync,
  close: closeSync,
};

const envelopeSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('rows'),
    rows: z.array(z.unknown()).min(1),
  })
  .strict();

export function serializeGrowingEnvelope<Row>(rows: readonly Row[]): Buffer {
  if (!rows.length) throw new Error('Growing envelope requires at least one row.');
  return Buffer.from(`${JSON.stringify({ version: 1, type: 'rows', rows })}\n`);
}

function parseEnvelopeLine<Row>(
  path: string,
  lineLabel: string,
  line: string,
  rowSchema: z.ZodType<Row>,
): Row[] {
  if (line.length === 0) throw new Error(`Growing file '${path}' ${lineLabel} is empty.`);
  try {
    const envelope = envelopeSchema.parse(JSON.parse(line));
    return envelope.rows.map((row) => rowSchema.parse(row));
  } catch (error) {
    throw new Error(
      `Growing file '${path}' ${lineLabel} is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function parseGrowingFile<Row>(path: string, bytes: Buffer, rowSchema: z.ZodType<Row>): Row[] {
  if (bytes.byteLength === 0) throw new Error(`Growing file '${path}' is empty.`);
  if (bytes.at(-1) !== 0x0a)
    throw new Error(`Growing file '${path}' has an incomplete final envelope.`);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `Growing file '${path}' is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const lines = content.split('\n');
  lines.pop();
  return lines.flatMap((line, index) =>
    parseEnvelopeLine(path, `envelope ${index + 1}`, line, rowSchema),
  );
}

export function readCanonicalBytes(
  path: string,
  instrumentation?: CanonicalReadInstrumentation,
): Buffer {
  instrumentation?.onRead(path);
  return readFileSync(path);
}

export function readCanonicalBytesOrMissing(
  path: string,
  instrumentation?: CanonicalReadInstrumentation,
): Buffer | null {
  instrumentation?.onRead(path);
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// The format owner validates the complete retained prefix before any mutation.
export function consumeGrowingFile<T>(
  path: string,
  bytes: Buffer,
  validate: (bytes: Buffer) => T,
  io: GrowingFileTruncationIo = growingFileTruncationIo,
): T {
  if (bytes.byteLength === 0) throw new Error(`Growing file '${path}' is empty.`);
  if (bytes.at(-1) === 0x0a) return validate(bytes);
  const newline = bytes.lastIndexOf(0x0a);
  if (newline < 0)
    throw new Error(
      `Growing file '${path}' has no complete prefix before its unterminated suffix.`,
    );
  const length = newline + 1;
  const projection = validate(bytes.subarray(0, length));
  const descriptor = io.open(path, constants.O_RDWR);
  try {
    io.ftruncate(descriptor, length);
    io.fsync(descriptor);
    io.close(descriptor);
  } catch (error) {
    throw new PublicationOutcomeUnknownError(error);
  }
  return projection;
}

export function consumeGrowingRows<Row, T>(
  path: string,
  bytes: Buffer,
  rowSchema: z.ZodType<Row>,
  validate: (rows: Row[]) => T,
): T {
  return consumeGrowingFile(path, bytes, (prefix) =>
    validate(parseGrowingFile(path, prefix, rowSchema)),
  );
}

export function admitGrowingFileTail<Row>(
  path: string,
  rowSchema: z.ZodType<Row>,
  validate: (rows: Row[]) => void,
): void {
  const bytes = readCanonicalBytesOrMissing(path);
  if (bytes === null) return;
  if (bytes.byteLength === 0) throw new Error(`Growing file '${path}' is empty.`);
  if (bytes.at(-1) !== 0x0a) {
    consumeGrowingRows(path, bytes, rowSchema, validate);
    return;
  }
  const priorTerminator = bytes.lastIndexOf(0x0a, bytes.byteLength - 2);
  let line: string;
  try {
    line = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(priorTerminator + 1, -1),
    );
  } catch (error) {
    throw new Error(`Growing file '${path}' final envelope is malformed.`, { cause: error });
  }
  parseEnvelopeLine(path, 'final envelope', line, rowSchema);
}

export function publishFirstEnvelope(
  target: string,
  bytes: Buffer,
  publicationTemporaryId?: PublicationTemporaryIdFactory,
  replacementIo?: ReplacementFileIo,
): void {
  try {
    lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      replaceFile(target, bytes, publicationTemporaryId, replacementIo);
      return;
    }
    throw error;
  }
  throw new Error(`Growing file '${target}' is already published.`);
}

type AppendEnvelopeResult = { readonly kind: 'appended' } | { readonly kind: 'missing' };

export function appendEnvelope(
  target: string,
  bytes: Buffer,
  io: GrowingFileIo = growingFileIo,
): AppendEnvelopeResult {
  let fd: number;
  try {
    fd = io.open(target, constants.O_WRONLY | constants.O_APPEND);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }

  try {
    writeAllExact(fd, bytes, io.write, () => new Error('zero progress'));
    io.fsync(fd);
    io.close(fd);
  } catch (error) {
    throw new PublicationOutcomeUnknownError(error);
  }
  return { kind: 'appended' };
}

export function appendRequiredEnvelope(target: string, bytes: Buffer, io?: GrowingFileIo): void {
  if (appendEnvelope(target, bytes, io).kind === 'missing')
    throw new Error(`Growing stream '${target}' is missing for append.`);
}
