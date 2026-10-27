import { readCommittedCardCurrent } from '../../persistence/index.js';
import {
  readCardExecutions,
  type CardExecutionRow,
  type CardExecutionStart,
  type CardExecutionObservation,
  type CardExecutionBinding,
} from '../../persistence/index.js';
import { isSecretKey, neutralSecretValue, redactTextForOutbound } from '../../redaction/index.js';
import type { OperatorApiHandlerResult, OperatorApiSuccess } from '../../contracts/index.js';
import type { WorkspaceFileReadModelService } from './workspace-file-read-model.js';
import type { CardNativeExecutionStart } from '../../persistence/card-execution-log.js';

type ExecutionDetail = Extract<OperatorApiSuccess<'cards.executions.get'>, { family: 'action' }>;
type NativeDetail = Extract<OperatorApiSuccess<'cards.executions.get'>, { family: 'native' }>;

function projectNativeFacts(facts: NativeDetail['facts']): NativeDetail['facts'] {
  if (!facts) return null;
  return { ...facts,
    source: facts.source ? { ...facts.source, branch_ref: redactTextForOutbound(facts.source.branch_ref) } : null,
    parent: facts.parent ? { ...facts.parent, branch_ref: redactTextForOutbound(facts.parent.branch_ref) } : null,
    retained_original_ref: redactNullable(facts.retained_original_ref),
    preserved_source: facts.preserved_source ? { ...facts.preserved_source, ref: redactTextForOutbound(facts.preserved_source.ref) } : null,
  };
}

// Classify the original name, not its display projection or the unrelated key "value".
function projectObservation(
  observation: CardExecutionObservation,
): ExecutionDetail['input'][number] {
  const secret = isSecretKey(observation.name);
  const name = redactTextForOutbound(observation.name);
  switch (observation.type) {
    case 'string':
      return {
        name,
        type: 'string',
        value: secret
          ? neutralSecretValue(observation.value)
          : redactTextForOutbound(observation.value),
      };
    case 'integer':
      return {
        name,
        type: 'integer',
        value: secret ? neutralSecretValue(observation.value) : observation.value,
      };
    case 'boolean':
      return {
        name,
        type: 'boolean',
        value: secret ? neutralSecretValue(observation.value) : observation.value,
      };
    case 'strings':
      return {
        name,
        type: 'strings',
        value: observation.value.map((value) =>
          secret ? neutralSecretValue(value) : redactTextForOutbound(value),
        ),
      };
  }
}
function projectBinding(binding: CardExecutionBinding): ExecutionDetail['binding'] {
  return binding.kind === 'node'
    ? { ...binding, node_id: redactTextForOutbound(binding.node_id) }
    : binding;
}
function redactNullable(value: string | null): string | null {
  return value === null ? null : redactTextForOutbound(value);
}
const notFound = { statusCode: 404 as const, body: { error: 'Execution evidence unavailable.' } };
type FileResult =
  | Exclude<OperatorApiHandlerResult<'cards.executions.file'>, { statusCode?: 200 }>
  | { statusCode: 200; body: OperatorApiSuccess<'cards.executions.file'> };

export class CardExecutionsReadModel {
  constructor(
    private readonly projectRoot: string,
    private readonly files: WorkspaceFileReadModelService,
  ) {}

  private read(id: string): CardExecutionRow[] | null {
    // Same exact linked/tombstoned target authority as supported historical card inspection.
    if (readCommittedCardCurrent(this.projectRoot, id).kind === 'card-not-found') return null;
    return readCardExecutions(this.projectRoot, id);
  }

  list(
    id: string,
    after: string | undefined,
    limit: number,
  ): OperatorApiHandlerResult<'cards.executions.list'> {
    const rows = this.read(id);
    if (!rows) return notFound;
    const index = after === undefined ? -1 : rows.findIndex((row) => row.row_id === after);
    if (after !== undefined && index < 0)
      return { statusCode: 400, body: { error: 'Unknown execution row cursor.' } };
    const starts = new Map(
      rows
        .filter((row): row is CardExecutionStart | CardNativeExecutionStart => row.kind === 'invocation_started' || row.kind === 'native_started')
        .map((row) => [row.invocation_id, row]),
    );
    const selected = rows.slice(index + 1, index + 1 + limit);
    return {
      body: {
        rows: selected.map((row) => {
          const start = starts.get(row.invocation_id)!; // Strict owning read validates every association.
          if (start.kind === 'native_started') {
            if (row.kind !== 'native_started' && row.kind !== 'native_process_started' && row.kind !== 'native_process_finished' && row.kind !== 'native_finished')
              throw new Error('Native execution family mismatch.');
            return { family: 'native' as const, row_id: row.row_id, invocation_id: row.invocation_id,
              timestamp: row.timestamp, kind: row.kind, step: start.step, binding: start.binding,
              disposition: row.kind === 'native_finished' || row.kind === 'native_process_finished' ? row.disposition : null };
          }
          if (row.kind !== 'invocation_started' && row.kind !== 'process_started' && row.kind !== 'invocation_finished')
            throw new Error('Action execution family mismatch.');
          return {
            family: 'action',
            row_id: row.row_id,
            invocation_id: row.invocation_id,
            timestamp: row.timestamp,
            kind: row.kind,
            operation: redactTextForOutbound(start.operation),
            contract_version: start.contract_version,
            binding: projectBinding(start.binding),
            disposition: row.kind === 'invocation_finished' ? row.disposition : null,
          } satisfies OperatorApiSuccess<'cards.executions.list'>['rows'][number];
        }),
        next_cursor: index + 1 + selected.length < rows.length ? selected.at(-1)!.row_id : null,
      },
    };
  }

  detail(id: string, invocationId: string): OperatorApiHandlerResult<'cards.executions.get'> {
    const rows = this.read(id)?.filter((row) => row.invocation_id === invocationId);
    const native = rows?.find((row) => row.kind === 'native_started');
    if (rows && native) return this.nativeDetail(rows, native);
    const start = rows?.find((row) => row.kind === 'invocation_started');
    if (!rows || !start) return notFound;
    const finish = rows.find((row) => row.kind === 'invocation_finished');
    const processes = rows.filter((row) => row.kind === 'process_started');
    const selectedRows = [...processes.slice(0, 100), ...(finish ? [finish] : [])];
    return {
      // Private configuration/env are deliberately not part of this public projection.
      body: {
        family: 'action',
        invocation_id: invocationId,
        operation: redactTextForOutbound(start.operation),
        contract_version: start.contract_version,
        provider: { kind: start.provider.kind, name: redactTextForOutbound(start.provider.name) },
        output_source: start.output_source,
        artifact_paths: start.artifact_paths.map(redactTextForOutbound),
        output: finish?.output ?? null,
        binding: projectBinding(start.binding),
        started_at: start.timestamp,
        finished_at: finish?.timestamp ?? null,
        completion: finish
          ? ('retained' as const)
          : ('no completion retained; effects unknown' as const),
        shell: start.shell
          ? {
              script: redactTextForOutbound(start.shell.script),
              cwd: redactTextForOutbound(start.shell.cwd),
              argv: start.shell.argv.map(redactTextForOutbound),
            }
          : null,
        input: start.input.map(projectObservation),
        disposition: finish?.disposition ?? null,
        summary: redactNullable(finish?.summary ?? null),
        outcome: redactNullable(finish?.outcome ?? null),
        leader_exit: finish?.leader_exit
          ? { ...finish.leader_exit, signal: redactNullable(finish.leader_exit.signal) }
          : null,
        leader_error: finish?.leader_error
          ? {
              ...finish.leader_error,
              diagnostic: redactTextForOutbound(finish.leader_error.diagnostic),
            }
          : null,
        interruption: redactNullable(finish?.interruption ?? null),
        timeout_reason: redactNullable(finish?.timeout_reason ?? null),
        process: finish?.process
          ? {
              ...finish.process,
              group_diagnostic: redactNullable(finish.process.group_diagnostic),
              stdout_error: redactNullable(finish.process.stdout_error),
              stderr_error: redactNullable(finish.process.stderr_error),
            }
          : null,
        processes: processes
          .slice(0, 100)
          .map((row) => ({ process_id: row.process_id, timestamp: row.timestamp })),
        processes_truncated: processes.length > 100,
        values: finish?.values.map(projectObservation) ?? [],
        files: selectedRows.flatMap((row) =>
          row.files.map((file, ordinal) => ({
            key: `${row.row_id}:${ordinal}`,
            label: file.kind === 'capture' ? file.stream : redactTextForOutbound(file.path),
            source: file.kind === 'capture' ? ('capture' as const) : ('current' as const),
            observed_at: file.kind === 'artifact' ? file.observed_at : null,
            size: file.kind === 'artifact' ? file.size : null,
          })),
        ),
        absent_artifacts: finish?.absent_artifacts.map(redactTextForOutbound) ?? [],
        external_effects: 'unknown' as const,
      } satisfies ExecutionDetail,
    };
  }

  private nativeDetail(rows: CardExecutionRow[], start: CardNativeExecutionStart): OperatorApiHandlerResult<'cards.executions.get'> {
    const finish = rows.find(row => row.kind === 'native_finished');
    const processes = rows.filter(row => row.kind === 'native_process_started');
    const visible = processes.slice(0, 100);
    const selectedRows = [...visible, ...(finish ? [finish] : [])];
    return { body: {
      family: 'native', invocation_id: start.invocation_id, step: start.step, binding: start.binding,
      artifact_paths: start.artifact_paths.map(redactTextForOutbound),
      started_at: start.timestamp, finished_at: finish?.timestamp ?? null,
      completion: finish ? 'retained' : 'no completion retained; effects unknown',
      disposition: finish?.disposition ?? null, summary: redactNullable(finish?.summary ?? null),
      outcome: finish?.outcome ?? null, effects: finish?.effects ?? [],
      facts: projectNativeFacts(finish?.facts ?? null), source_return: finish?.source_return ?? 'unknown',
      interruption: redactNullable(finish?.interruption ?? null), timeout_reason: redactNullable(finish?.timeout_reason ?? null),
      commands: visible.map(row => {
        const end = rows.find(item => item.kind === 'native_process_finished' && item.process_id === row.process_id);
        if (end && end.kind !== 'native_process_finished') throw new Error('Native command selection mismatch.');
        return { process_id: row.process_id, timestamp: row.timestamp, allowed_exit_codes: row.allowed_exit_codes,
          finished_at: end?.timestamp ?? null, status: end?.status ?? null, disposition: end?.disposition ?? null,
          leader_exit: end?.leader_exit ? { ...end.leader_exit, signal: redactNullable(end.leader_exit.signal) } : null,
          leader_error: end?.leader_error ? { ...end.leader_error, diagnostic: redactTextForOutbound(end.leader_error.diagnostic) } : null,
          process: end?.process ? { ...end.process, group_diagnostic: redactNullable(end.process.group_diagnostic),
            stdout_error: redactNullable(end.process.stdout_error), stderr_error: redactNullable(end.process.stderr_error) } : null,
          interruption: redactNullable(end?.interruption ?? null), timeout_reason: redactNullable(end?.timeout_reason ?? null) };
      }),
      processes_truncated: processes.length > visible.length,
      files: selectedRows.flatMap(row => row.files.map((file, ordinal) => ({
        key: `${row.row_id}:${ordinal}`, label: file.kind === 'capture' ? file.stream : redactTextForOutbound(file.path),
        source: file.kind === 'capture' ? 'capture' as const : 'current' as const,
        observed_at: file.kind === 'artifact' ? file.observed_at : null, size: file.kind === 'artifact' ? file.size : null,
      }))), absent_artifacts: finish?.absent_artifacts.map(redactTextForOutbound) ?? [], external_effects: 'unknown',
    } satisfies NativeDetail };
  }

  async file(id: string, invocationId: string, key: string): Promise<FileResult> {
    const rows = this.read(id);
    if (!rows) return notFound;
    const [rowId, ordinal] = key.split(':');
    const row = rows.find((item) => item.row_id === rowId && item.invocation_id === invocationId);
    const file = row && 'files' in row ? row.files[Number(ordinal)] : undefined;
    if (!file) return notFound;
    const result = await this.files.readFileContent(file.path);
    if (result.statusCode && result.statusCode !== 200) {
      const statusCode =
        result.statusCode === 404
          ? 404
          : result.statusCode === 413
            ? 413
            : result.statusCode === 415
              ? 415
              : 403;
      return {
        statusCode,
        body: {
          error:
            statusCode === 404 ? 'Selected file unavailable.' : 'Selected file access refused.',
        },
      };
    }
    if (!('content' in result.body))
      return { statusCode: 415, body: { error: 'Selected file is not bounded text.' } };
    return {
      statusCode: 200,
      body: {
        content: redactTextForOutbound(result.body.content),
        source: file.kind === 'capture' ? 'capture' : 'current',
        redacted: true,
      },
    };
  }
}
