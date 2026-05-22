import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  listProcesses,
  getProcess,
} from '../../runtime/process-runner.js';
import type { ProcessRecord } from '../../schemas/types.js';
import {
  redactCommandForOperator,
  redactOperatorErrorMessage,
  toContainedRelativePath,
} from '../../utils/file-access-security.js';

interface ProcessLogRefs {
  stdout: string | null;
  stderr: string | null;
  combined: string | null;
}

interface ProcessControlAvailability {
  can_view_logs: boolean;
  termination_available: false;
  unavailable_reason: string;
}

export interface ProcessView {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  timed_out: boolean;
  owner: string | null;
  session_id: string | null;
  card_id: string;
  command: string;
  cwd: string | null;
  logs: ProcessLogRefs;
  control: ProcessControlAvailability;
}

function hasTimedOut(record: ProcessRecord): boolean {
  return record.exit_code === null && record.status === 'failed';
}

function safeLogRef(projectRoot: string, path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  return toContainedRelativePath(projectRoot, path);
}

function safeCwd(projectRoot: string, cwd: string | null | undefined): string | null {
  if (!cwd) {
    return null;
  }
  return toContainedRelativePath(projectRoot, cwd);
}

function toProcessControlAvailability(canViewLogs: boolean): ProcessControlAvailability {
  return {
    can_view_logs: canViewLogs,
    termination_available: false,
    unavailable_reason: 'Process termination is not available in this redesign cycle.',
  };
}

function toProcessView(projectRoot: string, record: ProcessRecord): ProcessView {
  const logs = {
    stdout: safeLogRef(projectRoot, record.stdout_path),
    stderr: safeLogRef(projectRoot, record.stderr_path),
    combined: safeLogRef(projectRoot, record.combined_log_path),
  };
  const canViewLogs = Boolean(logs.stdout || logs.stderr || logs.combined);

  return {
    id: record.id,
    status: record.status,
    started_at: record.started_at,
    ended_at: record.completed_at ?? null,
    exit_code: record.exit_code ?? null,
    timed_out: hasTimedOut(record),
    owner: record.owner_kind ?? null,
    session_id: record.agent_session_id ?? null,
    card_id: record.card_id,
    command: redactCommandForOperator(record.command),
    cwd: safeCwd(projectRoot, record.cwd),
    logs,
    control: toProcessControlAvailability(canViewLogs),
  };
}

function processRouteMessage(err: unknown, projectRoot: string): string {
  return redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot);
}

export function registerProcessRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
): void {
  fastify.get('/api/processes', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const processes = listProcesses(projectRoot).map((record) => toProcessView(projectRoot, record));
      return reply.send({ processes });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to list processes',
        message: processRouteMessage(err, projectRoot),
      });
    }
  });

  fastify.get('/api/processes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const procId = params.id;

      if (!procId) {
        return reply.status(400).send({ error: 'Process ID is required.' });
      }

      const process = getProcess(projectRoot, procId);

      if (!process) {
        return reply.status(404).send({
          error: 'Process not found',
          processId: procId,
        });
      }

      return reply.send({ process: toProcessView(projectRoot, process) });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to get process',
        message: processRouteMessage(err, projectRoot),
      });
    }
  });
}
