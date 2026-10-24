import { randomUUID } from 'node:crypto';
import { statSync, readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { relative } from 'node:path';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';
import {
  actionOutputDescriptorSchema,
  type ActionOutputDescriptor,
  sha256Hex,
} from '../schemas/index.js';
import { z } from 'zod';
import {
  type CardExecutionRow,
  type CardExecutionFile,
  type CardExecutionFinish,
  type CardExecutionObservation,
} from '../persistence/index.js';
import { isReadBlocked, resolveContainedProjectPath } from '../workspace/index.js';
import { redactTextForOutbound } from '../redaction/index.js';
import {
  ProcessEvidenceUnavailableError,
  type ManagedProcessScope,
  type ProcessRecord,
  type ProcessRunner,
  type ProcessCategory,
} from './process-runner.js';
import {
  validateOperationRunResult,
  validateOperationValues,
  type OperationReturn,
  type OperationValues,
  type OperationDefinition,
} from './card-process/operation-contract.js';
import { shellOperationConfigSchema } from './card-process/shell-operation.js';

type WithoutCard<T> = T extends unknown ? Omit<T, 'card_id' | 'binding'> : never;
type OperationEvidenceRow = WithoutCard<CardExecutionRow>;
interface FiniteOperationInvocation {
  invocationId: string;
  projectRoot: string;
  operation: OperationDefinition;
  config: unknown;
  inputs: OperationValues;
  processRunner: ProcessRunner;
  parentScope: ManagedProcessScope;
  attribution: {
    category: ProcessCategory;
    cardId: string | null;
    ownerId: string;
    ownerKind: 'agent' | 'operator' | 'runtime';
    agentSessionId?: string;
  };
  collectOutput: boolean;
  resolveReadablePath(path: string): string;
  observe?(row: OperationEvidenceRow): void;
  signal: AbortSignal;
  retainSettlementFailure(error: unknown): void;
}
interface CompletedOperationOutput {
  readonly content: string;
  readonly descriptor: ActionOutputDescriptor;
  readonly processId: string | null;
  readonly leaderExit: Readonly<{ exit_code: number | null; signal: string | null }> | null;
}
export interface OperationExecutionResult {
  readonly invocationId: string;
  readonly result: OperationReturn;
  readonly completedOutput: CompletedOperationOutput | null;
  readonly evidence: Omit<CardExecutionFinish, 'card_id'>;
}
function observations(values: OperationValues): CardExecutionObservation[] {
  return Object.entries(values).map(([name, value]) =>
    typeof value === 'string'
      ? { name, type: 'string', value }
      : typeof value === 'number'
        ? { name, type: 'integer', value }
        : typeof value === 'boolean'
          ? { name, type: 'boolean', value }
          : { name, type: 'strings', value: [...value] },
  );
}
export function resolveOperationReadablePath(root: string, path: string): string {
  const selected = resolveContainedProjectPath(root, path);
  if (
    !selected.safe ||
    isReadBlocked(path) ||
    (selected.realTargetProjectRelativePath &&
      isReadBlocked(selected.realTargetProjectRelativePath))
  )
    throw new Error('Operation file is unavailable under Files privacy policy.');
  return selected.absolutePath;
}

/** Owns the whole finite raw body, including command callbacks, cleanup and evidence. */
export async function executeFiniteOperation(
  args: FiniteOperationInvocation,
): Promise<OperationExecutionResult> {
  const { signal, operation, processRunner: runner, projectRoot, attribution } = args;
  signal.throwIfAborted();
  const inputs = validateOperationValues(operation.inputs, args.inputs);
  const config = operation.config.parse(args.config);
  const shell = operation.id === 'shell.run' ? shellOperationConfigSchema.parse(config) : null;
  const invocationId = args.invocationId;
  const artifacts = exactArtifactPaths.parse(operation.artifacts(config, invocationId));
  const identity = () => ({
    row_id: randomUUID(),
    invocation_id: invocationId,
    timestamp: new Date().toISOString(),
  });
  let settlementFailure: { error: unknown } | null = null;
  const retain = (error: unknown): void => {
    settlementFailure ??= { error };
    args.retainSettlementFailure(error);
  };
  const observe = (row: OperationEvidenceRow): void => {
    try {
      args.observe?.(row);
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        runner.fatalPort.publicationOutcomeUnknown(error);
      retain(error);
      throw error;
    }
  };
  const safeInputs = Object.fromEntries(
    Object.entries(inputs).filter(([name]) => operation.inputs[name]!.workflow),
  );
  const argv = shell
    ? [
        '--noprofile',
        '--norc',
        '-o',
        'pipefail',
        '-c',
        shell.script,
        'saivage-action',
        ...(inputs.args as readonly string[]),
      ]
    : null;
  if (shell && redactTextForOutbound(JSON.stringify(inputs.args)) !== JSON.stringify(inputs.args))
    throw new Error('Shell arguments are not a secret delivery channel.');
  const cwd = shell ? args.resolveReadablePath(shell.cwd) : null;
  observe({
    ...identity(),
    kind: 'invocation_started',
    operation: operation.id,
    contract_version: operation.contractVersion,
    provider: operation.provider,
    output_source: operation.output,
    artifact_paths: artifacts,
    input: observations(safeInputs),
    config: [],
    shell: shell
      ? { script: shell.script, cwd: cwd!, argv: ['bash', ...argv!], env: shell.env }
      : null,
  });
  const scope = runner.createDirectScope(
    args.parentScope,
    `operation:${invocationId}`,
    attribution.category,
  );
  let record: ProcessRecord | null = null;
  let timeoutReason: string | null = null;
  let result: OperationReturn | null = null;
  let returnedOutput: Uint8Array | null = null;
  let failure: { error: unknown } | null = null;
  let logFailure: { error: unknown } | null = null;
  const captures = (value: ProcessRecord): CardExecutionFile[] => [
    { kind: 'capture', stream: 'stdout', path: relative(projectRoot, value.stdout_path) },
    { kind: 'capture', stream: 'stderr', path: relative(projectRoot, value.stderr_path) },
  ];
  try {
    const raw = await operation.run(
      config,
      inputs,
      {
        invocationId,
        projectRoot,
        resolveReadablePath: args.resolveReadablePath,
        readCommandStdout: () => {
          const completed = record as ProcessRecord | null;
          if (
            !completed ||
            completed.evidence.group !== 'absent' ||
            completed.evidence.stdout !== 'eof' ||
            completed.evidence.stdout_error
          )
            throw new Error('Operation command stdout is not complete.');
          return readCompletedBytes(completed.stdout_path, 16 * 1024 * 1024);
        },
        readFile: (path) => readFileSync(args.resolveReadablePath(path), 'utf8'),
        command: async (command, commandSignal): Promise<OperationReturn> => {
          try {
            commandSignal.throwIfAborted();
            record = runner.spawnCaptured({
              file: 'bash',
              args: [
                '--noprofile',
                '--norc',
                '-o',
                'pipefail',
                '-c',
                command.script,
                'saivage-action',
                ...command.args,
              ],
              cwd: args.resolveReadablePath(command.cwd),
              env: { ...command.env },
              directScope: scope,
              ...attribution,
              onSpawn: (spawned) => {
                try {
                  observe({
                    ...identity(),
                    kind: 'process_started',
                    process_id: spawned.id,
                    files: captures(spawned),
                  });
                } catch (error) {
                  if (error instanceof PublicationOutcomeUnknownError) throw error;
                  logFailure = { error };
                  throw error;
                }
              },
            });
            let timer: ReturnType<typeof setTimeout>;
            let abort!: () => void;
            const interrupted = new Promise<'aborted'>((resolveAbort) => {
              abort = () => resolveAbort('aborted');
              commandSignal.addEventListener('abort', abort, { once: true });
              if (commandSignal.aborted) abort();
            });
            let winner: 'settled' | 'timeout' | 'aborted';
            const settlement = runner.waitForSettlement(record.id).catch((error) => {
              if (error instanceof PublicationOutcomeUnknownError) throw error;
              retain(error);
              throw error;
            });
            try {
              winner = await Promise.race([
                settlement.then(() => 'settled' as const),
                new Promise<'timeout'>((resolveTimeout) => {
                  timer = setTimeout(() => resolveTimeout('timeout'), command.timeoutMs);
                }),
                interrupted,
              ]);
            } finally {
              clearTimeout(timer!);
              commandSignal.removeEventListener('abort', abort);
            }
            if (winner !== 'settled') {
              if (winner === 'timeout') timeoutReason = `Command exceeded ${command.timeoutMs}ms.`;
              try {
                await runner.kill(record.id, {
                  directScope: scope,
                  category: attribution.category,
                  graceMs: command.terminateGraceMs,
                  reason: timeoutReason ?? 'operation interrupted',
                });
              } catch (error) {
                if (error instanceof PublicationOutcomeUnknownError) throw error;
                retain(error);
                throw error;
              }
            }
            // The runtime root may retire the presentation concurrently with this join.
            // Its existing settlement still owns the actual final evidence, not a reread.
            record = (await settlement).record;
            commandSignal.throwIfAborted();
            if (record.evidence.leader_error)
              throw new Error(`Command spawn failed: ${record.evidence.leader_error.diagnostic}`);
            if (timeoutReason)
              return {
                outcome: 'timed_out',
                summary: timeoutReason,
                values: { reason: timeoutReason },
              };
            const leader = record.evidence.leader_exit;
            if (!leader) throw new Error('Command has no observed leader exit.');
            if (leader.signal)
              return {
                outcome: 'signalled',
                summary: `Command terminated by ${leader.signal}.`,
                values: { signal: leader.signal },
              };
            if (leader.exit_code === null) throw new Error('Command exit code unavailable.');
            return {
              outcome: leader.exit_code === 0 ? 'passed' : 'failed',
              summary: `Command exited with code ${leader.exit_code}.`,
              values: { exit_code: leader.exit_code },
            };
          } catch (error) {
            if (error instanceof PublicationOutcomeUnknownError)
              runner.fatalPort.publicationOutcomeUnknown(error);
            throw error;
          }
        },
      },
      signal,
    );
    if (settlementFailure) throw (settlementFailure as { error: unknown }).error;
    signal.throwIfAborted();
    const completed = validateOperationRunResult(operation, raw);
    result = completed.result;
    returnedOutput = completed.output;
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError)
      runner.fatalPort.publicationOutcomeUnknown(error);
    if (error instanceof ProcessEvidenceUnavailableError) retain(error);
    failure = { error };
  }
  // Keep the live record reference through cleanup, which retires its presentation.
  const processId = (record as ProcessRecord | null)?.id;
  try {
    const report = await runner.closeAndTerminateDirectScope({
      directScope: scope,
      category: attribution.category,
      reason: signal.aborted ? 'operation interrupted' : 'operation settled',
      graceMs: shell?.terminate_grace_ms,
    });
    if (report.failed.length)
      throw new Error(report.failed.map((item) => item.diagnostic).join('; '));
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError)
      runner.fatalPort.publicationOutcomeUnknown(error);
    retain(error);
    failure = { error };
  }
  if (logFailure) throw (logFailure as { error: unknown }).error;
  const observed = (processId ? runner.get(processId) : null) ?? (record as ProcessRecord | null);
  const files: CardExecutionFile[] = observed ? captures(observed) : [];
  const absent: string[] = [];
  try {
    for (const path of artifacts) {
      let stat;
      try {
        // Caller admission may itself consume filesystem identity (realpath).
        // An unpublished selected artifact is absent at either read boundary;
        // never bypass admission or turn any other refusal into absence.
        stat = statSync(args.resolveReadablePath(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        absent.push(path);
        continue;
      }
      if (stat.isFile())
        files.push({
          kind: 'artifact',
          path,
          observed_at: new Date().toISOString(),
          size: stat.size,
          source: 'current',
        });
      else absent.push(path);
    }
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError)
      runner.fatalPort.publicationOutcomeUnknown(error);
    retain(error);
    throw error;
  }
  let completedOutput: CompletedOperationOutput | null = null;
  if (!failure && !signal.aborted && args.collectOutput) {
    try {
      let content: string;
      if (operation.output === 'command-stdout') {
        if (
          !observed ||
          observed.evidence.group !== 'absent' ||
          observed.evidence.stdout !== 'eof' ||
          observed.evidence.stdout_error
        )
          throw new Error('Operation stdout capture is not complete.');
        content = readCompletedOutput(observed.stdout_path);
      } else if (operation.output === 'returned-text') {
        if (returnedOutput === null) throw new Error('Operation has no completed returned text.');
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(returnedOutput);
      } else throw new Error('Operation does not declare output.');
      completedOutput = {
        content,
        descriptor: actionOutputDescriptorSchema.parse({
          source: operation.output,
          size_bytes: Buffer.byteLength(content),
          sha256: sha256Hex(content),
        }),
        processId: observed?.id ?? null,
        leaderExit: observed?.evidence.leader_exit
          ? {
              exit_code: observed.evidence.leader_exit.exit_code,
              signal: observed.evidence.leader_exit.signal,
            }
          : null,
      };
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        runner.fatalPort.publicationOutcomeUnknown(error);
      failure = { error };
    }
  }
  const cancelled = signal.aborted && failure?.error === signal.reason;
  const accepted = failure ? null : result;
  const finish: Omit<CardExecutionFinish, 'card_id'> = {
    ...identity(),
    kind: 'invocation_finished',
    disposition: cancelled
      ? 'cancelled'
      : observed?.evidence.leader_error
        ? 'spawn_failed'
        : failure
          ? 'unavailable'
          : timeoutReason
            ? 'timed_out'
            : 'returned',
    summary:
      accepted?.summary ??
      (cancelled
        ? 'Operation interrupted; external effects unknown.'
        : 'Operation failed; external effects unknown.'),
    leader_exit: observed?.evidence.leader_exit ?? null,
    leader_error: observed?.evidence.leader_error ?? null,
    interruption: cancelled ? String(signal.reason).slice(0, 4096) : null,
    timeout_reason: timeoutReason,
    process: observed
      ? {
          id: observed.id,
          group: observed.evidence.group,
          group_diagnostic: observed.evidence.group_diagnostic,
          stdout: observed.evidence.stdout,
          stderr: observed.evidence.stderr,
          stdout_error: observed.evidence.stdout_error,
          stderr_error: observed.evidence.stderr_error,
        }
      : null,
    outcome: accepted?.outcome ?? null,
    values: accepted
      ? observations(
          Object.fromEntries(
            Object.entries(accepted.values).filter(([name]) =>
              operation.retainFields.includes(name),
            ),
          ),
        )
      : [],
    files,
    output: completedOutput?.descriptor ?? null,
    absent_artifacts: absent,
    external_effects: 'unknown',
  };
  observe(finish);
  if (failure) throw failure.error;
  signal.throwIfAborted();
  return {
    invocationId,
    result: result!,
    completedOutput,
    evidence: finish,
  };
}

const exactArtifactPaths = z
  .array(
    z
      .string()
      .min(1)
      .refine(
        (path) =>
          !path.startsWith('/') &&
          !/[?*[\]{}]/u.test(path) &&
          !path.split('/').some((part) => part === '' || part === '.' || part === '..'),
        'Artifacts must be exact project-relative paths.',
      ),
  )
  .max(16)
  .refine((paths) => new Set(paths).size === paths.length, 'Duplicate artifact path.');

function readCompletedOutput(path: string): string {
  const bytes = readCompletedBytes(path, 1024 * 1024);
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (content.includes('\0')) throw new Error('Operation stdout contains NUL.');
  if (!content.trim()) throw new Error('Operation stdout is empty or whitespace-only.');
  return content;
}

function readCompletedBytes(path: string, limit: number): Uint8Array {
  const fd = openSync(path, 'r');
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Operation stdout capture is not a regular file.');
    const buffer = Buffer.alloc(limit + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > limit) throw new Error(`Operation stdout exceeds ${limit} bytes.`);
    if (size < stat.size) throw new Error('Operation stdout capture read is incomplete.');
    bytes = buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
  return bytes;
}
