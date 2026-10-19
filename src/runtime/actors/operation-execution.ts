import { randomUUID } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { PublicationOutcomeUnknownError } from '../../contracts/index.js';
import {
  appendCardExecutions,
  type CardExecutionBinding,
  type CardExecutionFile,
  type CardExecutionFinish,
  type CardExecutionObservation,
} from '../../persistence/index.js';
import { isReadBlocked, resolveContainedProjectPath } from '../../workspace/index.js';
import { redactTextForOutbound } from '../../redaction/index.js';
import {
  ProcessEvidenceUnavailableError,
  type ManagedProcessScope,
  type ProcessRecord,
  type ProcessRunner,
} from '../process-runner.js';
import {
  validateOperationReturn,
  validateOperationValues,
  type OperationReturn,
  type OperationValues,
} from '../card-process/operation-contract.js';
import type { CompiledActionExecution } from '../card-process/operation-routing.js';
import { shellOperationConfigSchema } from '../card-process/shell-operation.js';

export interface OperationInvocation {
  projectRoot: string;
  cardId: string;
  execution: CompiledActionExecution;
  inputs: OperationValues;
  binding: CardExecutionBinding;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  signal: AbortSignal;
  retainSettlementFailure(error: unknown): void;
}
interface OperationExecutionResult {
  readonly invocationId: string;
  readonly result: OperationReturn;
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
function readablePath(root: string, path: string): string {
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
export async function invokeOperation(
  args: OperationInvocation,
): Promise<OperationExecutionResult> {
  const { signal, execution, processRunner: runner, projectRoot, cardId } = args;
  signal.throwIfAborted();
  const inputs = validateOperationValues(execution.operation.inputs, args.inputs);
  const config = execution.operation.config.parse(execution.config);
  const shell =
    execution.operation.id === 'shell.run' ? shellOperationConfigSchema.parse(config) : null;
  const invocationId = randomUUID();
  const identity = () => ({
    row_id: randomUUID(),
    invocation_id: invocationId,
    card_id: cardId,
    timestamp: new Date().toISOString(),
  });
  let settlementFailure: { error: unknown } | null = null;
  const retain = (error: unknown): void => {
    settlementFailure ??= { error };
    args.retainSettlementFailure(error);
  };
  const append = (rows: Parameters<typeof appendCardExecutions>[2]): void => {
    try {
      appendCardExecutions(projectRoot, cardId, rows);
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        runner.fatalPort.publicationOutcomeUnknown(error);
      retain(error);
      throw error;
    }
  };
  const safeInputs = Object.fromEntries(
    Object.entries(inputs).filter(([name]) => execution.operation.inputs[name]!.workflow),
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
  const cwd = shell ? readablePath(projectRoot, shell.cwd) : null;
  append([
    {
      ...identity(),
      kind: 'invocation_started',
      operation: execution.operation.id,
      contract_version: execution.operation.contractVersion,
      provider: execution.operation.provider,
      binding: args.binding,
      input: observations(safeInputs),
      config: [],
      shell: shell
        ? { script: shell.script, cwd: cwd!, argv: ['bash', ...argv!], env: shell.env }
        : null,
    },
  ]);
  const scope = runner.createDirectScope(
    args.runtimeProcessRootScope,
    `operation:${invocationId}`,
    'runtime_card',
  );
  let record: ProcessRecord | null = null;
  let timeoutReason: string | null = null;
  let result: OperationReturn | null = null;
  let failure: { error: unknown } | null = null;
  let logFailure: { error: unknown } | null = null;
  const captures = (value: ProcessRecord): CardExecutionFile[] => [
    { kind: 'capture', stream: 'stdout', path: relative(projectRoot, value.stdout_path) },
    { kind: 'capture', stream: 'stderr', path: relative(projectRoot, value.stderr_path) },
  ];
  try {
    const raw = await execution.operation.run(
      config,
      inputs,
      {
        readFile: (path) => readFileSync(readablePath(projectRoot, path), 'utf8'),
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
              cwd: readablePath(projectRoot, command.cwd),
              env: { ...command.env },
              directScope: scope,
              category: 'runtime_card',
              cardId,
              ownerId: invocationId,
              ownerKind: 'runtime',
              onSpawn: (spawned) => {
                try {
                  append([
                    {
                      ...identity(),
                      kind: 'process_started',
                      process_id: spawned.id,
                      files: captures(spawned),
                    },
                  ]);
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
                  category: 'runtime_card',
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
    result = validateOperationReturn(execution.operation, raw);
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
      category: 'runtime_card',
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
    for (const path of shell?.artifacts ?? []) {
      const absolute = readablePath(projectRoot, path);
      let stat;
      try {
        stat = statSync(absolute);
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
  const cancelled = signal.aborted && failure?.error === signal.reason;
  const accepted = failure ? null : result;
  const finish: CardExecutionFinish = {
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
              execution.operation.retainFields.includes(name),
            ),
          ),
        )
      : [],
    files,
    absent_artifacts: absent,
    external_effects: 'unknown',
  };
  append([finish]);
  if (failure) throw failure.error;
  signal.throwIfAborted();
  return { invocationId, result: result! };
}
