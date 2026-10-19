import { z } from 'zod';
import { cardIdSchema, uuidV4Schema } from '../schemas/index.js';
import { cardExecutionFile } from './layout.js';
import { appendEnvelope, consumeGrowingFile, readCanonicalBytesOrMissing } from './growing-file.js';
import { publishFreshFile } from './replace-file.js';

const boundedText = z
  .string()
  .refine((value) => Buffer.byteLength(value) <= 4096, 'Execution text exceeds 4096 bytes.');
const operationId = z.string().regex(/^[a-z][a-z0-9-]{0,47}\.[a-z][a-z0-9-]{0,47}$/u);
const positiveVersion = z.number().int().safe().positive();
const identity = {
  row_id: uuidV4Schema,
  invocation_id: uuidV4Schema,
  card_id: cardIdSchema,
  timestamp: z.string().datetime(),
};
const artifactReference = z.object({ entry_id: uuidV4Schema, version: positiveVersion }).strict();
const bindingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('node'),
      activation_id: uuidV4Schema,
      node_id: z.string().min(1),
      ordinal: z.number().int().safe().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('card-hook'),
      activation_id: uuidV4Schema,
      hook: z.literal('after_activation_commit'),
      committed_card_artifact: artifactReference,
      status: z.enum(['done', 'blocked', 'failed']),
    })
    .strict(),
]);
const observationSchema = z.discriminatedUnion('type', [
  z.object({ name: boundedText, type: z.literal('string'), value: boundedText }).strict(),
  z
    .object({ name: boundedText, type: z.literal('integer'), value: z.number().int().safe() })
    .strict(),
  z.object({ name: boundedText, type: z.literal('boolean'), value: z.boolean() }).strict(),
  z
    .object({ name: boundedText, type: z.literal('strings'), value: z.array(boundedText).max(256) })
    .strict(),
]);
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.split('/').some((segment) => segment === '..' || segment === '' || segment === '.'),
    'Expected an exact project-relative path.',
  );
const fileReference = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('capture'),
      stream: z.enum(['stdout', 'stderr']),
      path: relativePath,
    })
    .strict(),
  z
    .object({
      kind: z.literal('artifact'),
      path: relativePath,
      observed_at: z.string().datetime(),
      size: z.number().int().safe().nonnegative(),
      source: z.literal('current'),
    })
    .strict(),
]);
const startSchema = z
  .object({
    ...identity,
    kind: z.literal('invocation_started'),
    operation: operationId,
    contract_version: positiveVersion,
    provider: z
      .object({
        kind: z.enum(['builtin', 'plugin']),
        name: boundedText.refine((name) => name.length > 0),
      })
      .strict(),
    binding: bindingSchema,
    input: z.array(observationSchema).max(32),
    config: z.array(observationSchema).max(32),
    shell: z
      .object({
        script: boundedText,
        cwd: boundedText,
        argv: z.array(boundedText).max(264),
        env: z.record(boundedText),
      })
      .strict()
      .nullable(),
  })
  .strict();
const processSchema = z
  .object({
    ...identity,
    kind: z.literal('process_started'),
    process_id: z.string().min(1),
    files: z.array(fileReference).length(2),
  })
  .strict();
const finishSchema = z
  .object({
    ...identity,
    kind: z.literal('invocation_finished'),
    disposition: z.enum([
      'returned',
      'spawn_failed',
      'failed',
      'cancelled',
      'timed_out',
      'unavailable',
    ]),
    summary: z.string().trim().min(1).max(2000),
    leader_exit: z
      .object({
        exit_code: z.number().int().safe().nullable(),
        signal: boundedText.nullable(),
        observed_at: z.string().datetime(),
      })
      .strict()
      .nullable(),
    leader_error: z
      .object({ diagnostic: boundedText, observed_at: z.string().datetime() })
      .strict()
      .nullable(),
    interruption: boundedText.nullable(),
    timeout_reason: boundedText.nullable(),
    process: z
      .object({
        id: z.string().min(1),
        group: z.enum(['tracked', 'absent', 'unverifiable']),
        group_diagnostic: boundedText.nullable(),
        stdout: z.enum(['open', 'eof', 'closed', 'not_captured']),
        stderr: z.enum(['open', 'eof', 'closed', 'not_captured']),
        stdout_error: boundedText.nullable(),
        stderr_error: boundedText.nullable(),
      })
      .strict()
      .nullable(),
    outcome: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
      .nullable(),
    values: z.array(observationSchema).max(32),
    files: z.array(fileReference).max(18),
    absent_artifacts: z.array(relativePath).max(16),
    external_effects: z.literal('unknown'),
  })
  .strict();
const cardExecutionRowSchema = z.discriminatedUnion('kind', [
  startSchema,
  processSchema,
  finishSchema,
]);
export type CardExecutionRow = z.infer<typeof cardExecutionRowSchema>;
export type CardExecutionStart = z.infer<typeof startSchema>;
export type CardExecutionFinish = z.infer<typeof finishSchema>;
export type CardExecutionObservation = z.infer<typeof observationSchema>;
export type CardExecutionFile = z.infer<typeof fileReference>;
export type CardExecutionBinding = z.infer<typeof bindingSchema>;
const envelopeSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('card-execution'),
    rows: z.array(cardExecutionRowSchema).min(1),
  })
  .strict();

function validateRows(cardId: string, rows: readonly CardExecutionRow[]): void {
  const rowIds = new Set<string>();
  const invocations = new Map<
    string,
    { started: CardExecutionStart; processes: Set<string>; finished: boolean }
  >();
  for (const row of rows) {
    if (row.card_id !== cardId || rowIds.has(row.row_id))
      throw new Error('Execution row identity mismatch or duplicate.');
    rowIds.add(row.row_id);
    if ('values' in row || 'input' in row) {
      const observations = 'values' in row ? row.values : row.input;
      if (
        new Set(observations.map((item) => item.name)).size !== observations.length ||
        Buffer.byteLength(
          JSON.stringify(Object.fromEntries(observations.map((item) => [item.name, item.value]))),
        ) > 65536
      )
        throw new Error('Execution observations are duplicate or oversized.');
    }
    if (row.kind === 'invocation_started') {
      if (invocations.has(row.invocation_id))
        throw new Error('Duplicate execution invocation start.');
      if (
        new Set(row.config.map((item) => item.name)).size !== row.config.length ||
        Buffer.byteLength(
          JSON.stringify(Object.fromEntries(row.config.map((item) => [item.name, item.value]))),
        ) > 65536
      )
        throw new Error('Execution configuration observations are duplicate or oversized.');
      if (row.operation === 'shell.run' && row.shell === null)
        throw new Error('Shell start needs actual command facts.');
      if (row.operation !== 'shell.run' && row.shell !== null)
        throw new Error('Non-shell start cannot claim shell facts.');
      invocations.set(row.invocation_id, { started: row, processes: new Set(), finished: false });
      continue;
    }
    const invocation = invocations.get(row.invocation_id);
    if (!invocation || invocation.finished)
      throw new Error('Execution row has no open invocation start.');
    if (row.kind === 'process_started') {
      if (invocation.processes.has(row.process_id))
        throw new Error('Duplicate execution process start.');
      if (
        row.files.some((file) => file.kind !== 'capture') ||
        new Set(row.files.map((file) => (file.kind === 'capture' ? file.stream : ''))).size !== 2
      )
        throw new Error('Process start needs exact stdout and stderr references.');
      invocation.processes.add(row.process_id);
    } else {
      if (row.process && !invocation.processes.has(row.process.id) && row.leader_error === null)
        throw new Error('Execution process facts have no observed spawn or spawn error.');
      if (row.disposition === 'spawn_failed' && (row.leader_error === null || row.outcome !== null))
        throw new Error('Spawn failure needs observed error and no configured outcome.');
      if (row.disposition === 'cancelled' && (row.interruption === null || row.outcome !== null))
        throw new Error('Cancellation needs exact interruption and no configured outcome.');
      if (row.disposition === 'timed_out' && row.timeout_reason === null)
        throw new Error('Timeout needs an explicit reason.');
      if (row.disposition !== 'returned' && row.disposition !== 'timed_out' && row.outcome !== null)
        throw new Error('Unaccepted execution cannot claim a configured outcome.');
      invocation.finished = true;
    }
  }
}

function parseRows(cardId: string, bytes: Buffer): CardExecutionRow[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const lines = text.split('\n');
  if (lines.pop() !== '') throw new Error('Execution log lacks its final newline.');
  const rows = lines.flatMap((line) => envelopeSchema.parse(JSON.parse(line)).rows);
  validateRows(cardId, rows);
  return rows;
}

export function readCardExecutions(projectRoot: string, cardId: string): CardExecutionRow[] {
  const path = cardExecutionFile(projectRoot, cardIdSchema.parse(cardId));
  const bytes = readCanonicalBytesOrMissing(path);
  if (bytes === null) return [];
  return consumeGrowingFile(path, bytes, (prefix) => parseRows(cardId, prefix));
}

/** Direct owner-local consumption; no retained admission or historical business decoder. */
export function appendCardExecutions(
  projectRoot: string,
  cardId: string,
  values: readonly CardExecutionRow[],
): void {
  const path = cardExecutionFile(projectRoot, cardIdSchema.parse(cardId));
  const envelope = envelopeSchema.parse({ version: 1, type: 'card-execution', rows: values });
  const prior = readCardExecutions(projectRoot, cardId);
  validateRows(cardId, [...prior, ...envelope.rows]);
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
  if (appendEnvelope(path, bytes).kind === 'missing') publishFreshFile(path, bytes);
}
