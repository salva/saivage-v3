import { z } from 'zod';
import { cardParentId } from '../schemas/index.js';
import {
  gitNativeStepSchema,
  nativeGitEffectSchema,
  nativeGitOutcomeSchema,
  nativeGitEvidenceFactsSchema,
  nativeGitExecutionBindingSchema,
} from '../schemas/index.js';
import { operationIdSchema } from '../schemas/index.js';
import { actionOutputDescriptorSchema, operationOutputSourceSchema } from '../schemas/index.js';
import { cardIdSchema, uuidV4Schema } from '../schemas/index.js';
import { cardExecutionFile } from './layout.js';
import {
  appendEnvelope,
  consumeGrowingFile,
  inspectGrowingFile,
  readCanonicalBytesOrMissing,
} from './growing-file.js';
import { publishFreshFile } from './replace-file.js';

const boundedText = z
  .string()
  .refine((value) => Buffer.byteLength(value) <= 4096, 'Execution text exceeds 4096 bytes.');
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
    operation: operationIdSchema,
    contract_version: positiveVersion,
    provider: z
      .object({
        kind: z.enum(['builtin', 'plugin']),
        name: boundedText.refine((name) => name.length > 0),
      })
      .strict(),
    output_source: operationOutputSourceSchema.nullable(),
    artifact_paths: z.array(relativePath).max(16),
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
    output: actionOutputDescriptorSchema.nullable(),
    absent_artifacts: z.array(relativePath).max(16),
    external_effects: z.literal('unknown'),
  })
  .strict();
const nativeStartSchema = z
  .object({
    ...identity,
    kind: z.literal('native_started'),
    step: gitNativeStepSchema,
    binding: nativeGitExecutionBindingSchema,
    artifact_paths: z.array(relativePath).max(1),
  })
  .strict();
const nativeProcessSchema = processSchema
  .extend({
    kind: z.literal('native_process_started'),
    allowed_exit_codes: z.array(z.number().int()).min(1).max(4),
  })
  .strict();
const nativeProcessFinishSchema = finishSchema
  .pick({
    row_id: true,
    invocation_id: true,
    card_id: true,
    timestamp: true,
    disposition: true,
    leader_exit: true,
    leader_error: true,
    interruption: true,
    timeout_reason: true,
  })
  .extend({
    kind: z.literal('native_process_finished'),
    process_id: z.string().min(1),
    status: z.enum(['running', 'exited', 'failed', 'killed', 'unavailable']),
    process: finishSchema.shape.process.unwrap(),
  })
  .strict();
const nativeFinishSchema = finishSchema
  .omit({
    kind: true,
    values: true,
    output: true,
    outcome: true,
    leader_exit: true,
    leader_error: true,
    process: true,
  })
  .extend({
    kind: z.literal('native_finished'),
    outcome: nativeGitOutcomeSchema.nullable(),
    effects: z.array(nativeGitEffectSchema).max(32),
    facts: nativeGitEvidenceFactsSchema.nullable(),
    source_return: z.enum(['returned', 'not_returned', 'unknown']),
  })
  .strict();
const cardExecutionRowSchema = z.discriminatedUnion('kind', [
  startSchema,
  processSchema,
  finishSchema,
  nativeStartSchema,
  nativeProcessSchema,
  nativeProcessFinishSchema,
  nativeFinishSchema,
]);
export type CardExecutionRow = z.infer<typeof cardExecutionRowSchema>;
export type CardExecutionStart = z.infer<typeof startSchema>;
export type CardExecutionFinish = z.infer<typeof finishSchema>;
export type CardNativeExecutionStart = z.infer<typeof nativeStartSchema>;
export type CardNativeExecutionFinish = z.infer<typeof nativeFinishSchema>;
export type CardNativeExecutionBinding = z.infer<typeof nativeGitExecutionBindingSchema>;
export type CardExecutionObservation = z.infer<typeof observationSchema>;
export type CardExecutionFile = z.infer<typeof fileReference>;
export type CardExecutionBinding = z.infer<typeof bindingSchema>;
const envelopeSchema = z
  .object({
    version: z.literal(3),
    type: z.literal('card-execution'),
    rows: z.array(cardExecutionRowSchema).min(1),
  })
  .strict();

function validateNativeOutcome(
  start: CardNativeExecutionStart,
  row: CardNativeExecutionFinish,
): void {
  if (
    row.outcome !== null &&
    row.outcome !== 'refused' &&
    row.outcome !== 'uncertain' &&
    (row.disposition !== 'returned' || row.interruption !== null || row.timeout_reason !== null)
  )
    throw new Error('Native logical success requires an uninterrupted returned disposition.');
  const outcomes = {
    commission: ['commissioned'],
    enter: ['entered', 'correction-required'],
    checkpoint: ['completed'],
    prepareCandidate: ['candidate'],
    verifyCorrection: ['correction-verified'],
    deliver: ['delivered'],
    preserveAndReturn: ['returned'],
    captureRebase: ['captured'],
    restoreRebaseAndReturn: ['returned'],
    inspect: ['completed'],
    switch: ['completed'],
  };
  if (
    row.outcome !== null &&
    row.outcome !== 'refused' &&
    row.outcome !== 'uncertain' &&
    !outcomes[start.step].includes(row.outcome)
  )
    throw new Error('Native outcome disagrees with invocation step.');
  if (row.outcome === null && (row.effects.length !== 0 || row.facts !== null))
    throw new Error('Unreported native outcome cannot assert effects or facts.');
  if (row.outcome !== null) {
    if (!row.facts) throw new Error('Reported native outcome requires its factual observation.');
    if (row.outcome !== 'refused' && row.outcome !== 'uncertain' && !row.facts.source)
      throw new Error('Completed native observation requires an exact source selection.');
    if ((row.outcome === 'returned' || row.outcome === 'delivered') && !row.facts.parent)
      throw new Error('Native return requires an exact parent selection.');
    if (
      (row.outcome === 'captured' || row.outcome === 'correction-required') &&
      (!row.facts.parent ||
        !row.facts.base_oid ||
        !row.facts.original_tip ||
        !row.facts.retained_original_ref)
    )
      throw new Error('Native correction observation requires original source provenance.');
    if (
      row.outcome === 'captured' &&
      (!row.facts.preserved_source || !row.facts.rebase_observation)
    )
      throw new Error('Native capture requires snapshot and interrupted rebase observations.');
    if (
      row.outcome === 'commissioned' &&
      (!row.facts.parent ||
        row.facts.source?.observed_tip !== row.facts.parent.observed_tip ||
        row.facts.base_oid !== row.facts.parent.observed_tip ||
        row.effects.length !== 1 ||
        row.effects[0] !== 'branch-created')
    )
      throw new Error('Commissioning requires actual initial branch allocation facts.');
  }
  if (
    row.source_return !==
    (row.outcome === 'returned' || row.outcome === 'delivered'
      ? 'returned'
      : row.outcome === null || row.outcome === 'uncertain'
        ? 'unknown'
        : 'not_returned')
  )
    throw new Error('Native source return disagrees with reported outcome.');
}

function validateRows(cardId: string, rows: readonly CardExecutionRow[]): void {
  const rowIds = new Set<string>();
  const invocations = new Map<
    string,
    {
      started: CardExecutionStart | CardNativeExecutionStart;
      processes: Map<string, CardExecutionFile[]>;
      finished: boolean;
      nativeOpen?: { id: string; allowed: number[] };
      nativeFailed?: boolean;
    }
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
    if (row.kind === 'native_started') {
      if (invocations.has(row.invocation_id))
        throw new Error('Duplicate execution invocation start.');
      if (
        (row.step === 'commission') !== (row.binding.origin === 'bootstrap') ||
        (row.binding.origin === 'bootstrap' && cardId !== 'project')
      )
        throw new Error(
          'Commissioning requires root bootstrap origin; other native steps require activation origin.',
        );
      if (
        row.binding.origin === 'activation' &&
        row.binding.parent_card_id !== cardParentId(cardId)
      )
        throw new Error('Native execution parent mismatch.');
      const expected = `.saivage/work/cards/${cardId}/tmp/native-git-${row.invocation_id}/index`;
      const capturesIndex = row.step === 'captureRebase' || row.step === 'restoreRebaseAndReturn';
      if (
        row.artifact_paths.length !== (capturesIndex ? 1 : 0) ||
        (capturesIndex && row.artifact_paths[0] !== expected)
      )
        throw new Error('Native execution index selection disagrees with step/invocation.');
      invocations.set(row.invocation_id, { started: row, processes: new Map(), finished: false });
      continue;
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
      if (row.operation === 'shell.run' && row.output_source !== 'command-stdout')
        throw new Error('Shell start requires command-stdout output declaration.');
      if (new Set(row.artifact_paths).size !== row.artifact_paths.length)
        throw new Error('Execution artifact declaration contains duplicates.');
      invocations.set(row.invocation_id, { started: row, processes: new Map(), finished: false });
      continue;
    }
    const invocation = invocations.get(row.invocation_id);
    if (!invocation || invocation.finished)
      throw new Error('Execution row has no open invocation start.');
    const native = invocation.started.kind === 'native_started';
    if (
      native !==
      (row.kind === 'native_process_started' ||
        row.kind === 'native_process_finished' ||
        row.kind === 'native_finished')
    )
      throw new Error('Execution row family disagrees with invocation start.');
    if (row.kind === 'process_started' || row.kind === 'native_process_started') {
      if (row.kind === 'native_process_started') {
        if (invocation.nativeOpen || invocation.nativeFailed)
          throw new Error('Native command has an unfinished or failed predecessor.');
        invocation.nativeOpen = { id: row.process_id, allowed: row.allowed_exit_codes };
      }
      if (invocation.processes.has(row.process_id))
        throw new Error('Duplicate execution process start.');
      if (
        row.files.some((file) => file.kind !== 'capture') ||
        new Set(row.files.map((file) => (file.kind === 'capture' ? file.stream : ''))).size !== 2
      )
        throw new Error('Process start needs exact stdout and stderr references.');
      if (
        native &&
        row.files.some(
          (file) =>
            file.kind !== 'capture' ||
            file.path !==
              `.saivage/work/cards/${cardId}/processes/${row.process_id}/${file.stream}.log`,
        )
      )
        throw new Error('Native capture selection disagrees with exact process owner.');
      invocation.processes.set(row.process_id, row.files);
    } else if (row.kind === 'native_process_finished') {
      if (invocation.nativeOpen?.id !== row.process_id || row.process.id !== row.process_id)
        throw new Error('Native process finish has no matching open command.');
      if (
        row.disposition === 'returned' &&
        (!['exited', 'failed'].includes(row.status) ||
          row.process.group !== 'absent' ||
          row.process.group_diagnostic !== null ||
          row.leader_error !== null ||
          !row.leader_exit ||
          row.leader_exit.signal !== null ||
          row.leader_exit?.exit_code === null ||
          !invocation.nativeOpen.allowed.includes(row.leader_exit.exit_code) ||
          row.process.stdout !== 'eof' ||
          row.process.stderr !== 'eof' ||
          row.process.stdout_error !== null ||
          row.process.stderr_error !== null ||
          row.interruption !== null ||
          row.timeout_reason !== null)
      )
        throw new Error('Native command success requires natural complete allowed settlement.');
      invocation.nativeFailed = row.disposition !== 'returned';
      delete invocation.nativeOpen;
    } else if (row.kind === 'native_finished') {
      if (invocation.started.kind !== 'native_started')
        throw new Error('Native finish needs native start.');
      if (invocation.nativeOpen)
        throw new Error('Native logical finish has an unfinished command.');
      if (
        row.outcome !== null &&
        row.outcome !== 'refused' &&
        row.outcome !== 'uncertain' &&
        (invocation.nativeFailed || invocation.processes.size === 0)
      )
        throw new Error('Native logical success has no naturally settled command chain.');
      if (row.files.some((file) => file.kind !== 'artifact'))
        throw new Error('Logical native finish cannot aggregate command captures.');
      const artifacts = [...row.files.map((file) => file.path), ...row.absent_artifacts];
      if (
        new Set(artifacts).size !== artifacts.length ||
        artifacts.length !== invocation.started.artifact_paths.length ||
        artifacts.some((path) => !invocation.started.artifact_paths.includes(path))
      )
        throw new Error('Native artifact observations disagree with exact selection.');
      validateNativeOutcome(invocation.started, row);
      invocation.finished = true;
    } else {
      if (row.process && !invocation.processes.has(row.process.id) && row.leader_error === null)
        throw new Error('Execution process facts have no observed spawn or spawn error.');
      const selectedCaptures = row.process ? invocation.processes.get(row.process.id) : undefined;
      const finishedCaptures = row.files.filter((file) => file.kind === 'capture');
      if (
        selectedCaptures &&
        (finishedCaptures.length !== selectedCaptures.length ||
          finishedCaptures.some(
            (file) =>
              !selectedCaptures.some(
                (selected) =>
                  selected.kind === 'capture' &&
                  selected.stream === file.stream &&
                  selected.path === file.path,
              ),
          ))
      )
        throw new Error(
          'Execution finish capture references disagree with observed process start.',
        );
      const artifactPaths = [
        ...row.files.flatMap((file) => (file.kind === 'artifact' ? [file.path] : [])),
        ...row.absent_artifacts,
      ];
      if (
        artifactPaths.length !== invocation.started.artifact_paths.length ||
        new Set(artifactPaths).size !== artifactPaths.length ||
        artifactPaths.some((path) => !invocation.started.artifact_paths.includes(path))
      )
        throw new Error('Execution artifact observations disagree with exact declared selection.');
      if (row.disposition === 'spawn_failed' && (row.leader_error === null || row.outcome !== null))
        throw new Error('Spawn failure needs observed error and no configured outcome.');
      if (row.disposition === 'cancelled' && (row.interruption === null || row.outcome !== null))
        throw new Error('Cancellation needs exact interruption and no configured outcome.');
      if (row.disposition === 'timed_out' && row.timeout_reason === null)
        throw new Error('Timeout needs an explicit reason.');
      if (row.disposition !== 'returned' && row.disposition !== 'timed_out' && row.outcome !== null)
        throw new Error('Unaccepted execution cannot claim a configured outcome.');
      if (row.kind === 'invocation_finished' && row.output) {
        if (invocation.started.kind !== 'invocation_started')
          throw new Error('Action output needs action start.');
        if (row.outcome === null || row.output.source !== invocation.started.output_source)
          throw new Error('Execution output has no matching accepted source declaration.');
        if (
          row.output.source === 'command-stdout' &&
          (!row.process ||
            row.process.group !== 'absent' ||
            row.process.stdout !== 'eof' ||
            row.process.stdout_error !== null ||
            !row.files.some((file) => file.kind === 'capture' && file.stream === 'stdout'))
        )
          throw new Error('Execution stdout output lacks complete captured process facts.');
      }
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

/** Pure inspection shares the ordinary reader's complete prefix and association checks. */
export function inspectCardExecutions(projectRoot: string, cardId: string) {
  const path = cardExecutionFile(projectRoot, cardIdSchema.parse(cardId));
  const bytes = readCanonicalBytesOrMissing(path);
  return bytes === null
    ? { projection: [] as CardExecutionRow[], retainedLength: 0, tornSuffixLength: 0 }
    : inspectGrowingFile(path, bytes, (prefix) => parseRows(cardId, prefix));
}

/** Direct owner-local consumption; no retained admission or historical business decoder. */
export function appendCardExecutions(
  projectRoot: string,
  cardId: string,
  values: readonly CardExecutionRow[],
): void {
  const path = cardExecutionFile(projectRoot, cardIdSchema.parse(cardId));
  const envelope = envelopeSchema.parse({ version: 3, type: 'card-execution', rows: values });
  const prior = readCardExecutions(projectRoot, cardId);
  validateRows(cardId, [...prior, ...envelope.rows]);
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
  if (appendEnvelope(path, bytes).kind === 'missing') publishFreshFile(path, bytes);
}
