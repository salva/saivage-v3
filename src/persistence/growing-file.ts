import { constants, closeSync, existsSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { z } from 'zod';

import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import { durablyReplaceFile } from './durable-file-replacement.js';
import { IndeterminatePublicationError } from './errors.js';

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

export function publishFirstEnvelope(
  target: string,
  bytes: Buffer,
  health: ApplicationPersistenceHealth,
  operation: string,
): void {
  health.assertMutationHealthy();
  if (existsSync(target)) throw new Error(`Growing file '${target}' is already published.`);
  try {
    durablyReplaceFile(target, bytes);
  } catch (error) {
    if (error instanceof IndeterminatePublicationError) health.reportUncertainFailure({ target, operation, error });
    throw error;
  }
}

export function appendEnvelope(
  target: string,
  bytes: Buffer,
  health: ApplicationPersistenceHealth,
  operation: string,
): void {
  health.assertMutationHealthy();
  let fd: number;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_APPEND);
  } catch (error) {
    throw error;
  }

  let uncertain = false;
  let failure: unknown;
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      uncertain = true;
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (written === 0) throw new Error(`Growing-file append made no progress at '${target}'.`);
      offset += written;
    }
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    if (uncertain) health.reportUncertainFailure({ target, operation, error: failure });
    throw failure;
  }
}
