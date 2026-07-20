import type { ProcessRecord } from '../../schemas/index.js';
import type { ProcessView } from '../../contracts/operator-api.js';
import { redactCommandForOperator, toContainedRelativePath, workUrlFromAbsolutePath } from '../../workspace/index.js';
import { defineOperatorContractHandlers, type OperatorProjectContext } from './operator-handler-context.js';
import type { ProcessRunner } from '../../runtime/process-runner.js';

type ProcessOperatorHandlerOptions = OperatorProjectContext & { processRunner: ProcessRunner };

export function toProcessView(projectRoot: string, record: ProcessRecord): ProcessView {
  const safePath = (path: string | null | undefined) => path ? toContainedRelativePath(projectRoot, path) : null;
  const logUrl = (path: string | null | undefined) => path ? workUrlFromAbsolutePath(projectRoot, path) : null;
  return {
    id: record.id,
    status: record.status,
    started_at: record.started_at,
    ended_at: record.completed_at ?? null,
    exit_code: record.exit_code ?? null,
    timed_out: record.exit_code === null && record.status === 'failed',
    owner_id: record.owner_id,
    owner_kind: record.owner_kind,
    session_id: record.agent_session_id ?? null,
    card_id: record.card_id,
    command: redactCommandForOperator(record.command),
    cwd: safePath(record.cwd),
    logs: { stdout: logUrl(record.stdout_path), stderr: logUrl(record.stderr_path) },
  };
}

export function buildProcessOperatorContractHandlers(options: ProcessOperatorHandlerOptions) {
  const processRunner = options.processRunner;

  return defineOperatorContractHandlers({
    'processes.list': () => ({ body: { processes: processRunner.list().map((record) => toProcessView(options.projectRoot, record)) } }),
    'processes.get': ({ params }) => {
      const processId = params.id;
      const record = processRunner.get(processId);
      const process = record ? { process: toProcessView(options.projectRoot, record) } : null;
      if (!process) {
        return {
          statusCode: 404,
          body: {
            error: 'Process not found',
            processId,
          },
        };
      }

      return { body: process };
    },
  });
}
