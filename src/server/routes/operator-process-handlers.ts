import type { ProcessRecord } from '../../schemas/index.js';
import type { OperatorApiResponse, ProcessView } from '../../contracts/operator-api.js';
import { redactCommandForOperator, redactOperatorErrorMessage, toContainedRelativePath, workUrlFromAbsolutePath } from '../../workspace/index.js';
import { defineOperatorContractHandlers, type OperatorProjectContext } from './operator-handler-context.js';

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

export function buildProcessOperatorContractHandlers(options: OperatorProjectContext) {
  const processRunner = options.processRunner;
  const unavailableBody: OperatorApiResponse<'processes.list', 500> & OperatorApiResponse<'processes.get', 500> = {
    error: 'Process runner unavailable',
    message: 'Process runner is required for process operator routes.',
  };

  return defineOperatorContractHandlers({
    'processes.list': () => {
      if (!processRunner) return { statusCode: 500, body: unavailableBody };
      try {
        return { body: { processes: processRunner.list().map((record) => toProcessView(options.projectRoot, record)) } };
      } catch (err) {
        return {
          statusCode: 500,
          body: {
            error: 'Failed to list processes',
            message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), options.projectRoot),
          },
        };
      }
    },
    'processes.get': ({ params }) => {
      if (!processRunner) return { statusCode: 500, body: unavailableBody };
      const processId = params.id;

      try {
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
      } catch (err) {
        return {
          statusCode: 500,
          body: {
            error: 'Failed to get process',
            message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), options.projectRoot),
          },
        };
      }
    },
  });
}
