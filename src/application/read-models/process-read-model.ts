import {
  getProcess,
  listProcesses,
} from '../../runtime/process-api.js';
import type { ProcessRecord } from '../../schemas/index.js';
import {
  redactCommandForOperator,
  redactOperatorErrorMessage,
  toContainedRelativePath,
} from '../../workspace/index.js';

export interface ProcessLogRefs {
  stdout: string | null;
  stderr: string | null;
  combined: string | null;
}

export interface ProcessControlAvailability {
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

export interface ProcessListResponse {
  processes: ProcessView[];
}

export interface ProcessDetailResponse {
  process: ProcessView;
}

function hasTimedOut(record: ProcessRecord): boolean {
  return record.exit_code === null && record.status === 'failed';
}

function safeProjectPath(projectRoot: string, path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  return toContainedRelativePath(projectRoot, path);
}

function toProcessControlAvailability(canViewLogs: boolean): ProcessControlAvailability {
  return {
    can_view_logs: canViewLogs,
    termination_available: false,
    unavailable_reason: 'Process termination is not available in this redesign cycle.',
  };
}

export class ProcessReadModelService {
  constructor(private readonly projectRoot: string) {}

  listProcesses(): ProcessListResponse {
    return {
      processes: listProcesses(this.projectRoot).map((record) => this.toProcessView(record)),
    };
  }

  getProcess(id: string): ProcessDetailResponse | null {
    const process = getProcess(this.projectRoot, id);
    return process ? { process: this.toProcessView(process) } : null;
  }

  errorMessage(err: unknown): string {
    return redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), this.projectRoot);
  }

  toProcessView(record: ProcessRecord): ProcessView {
    const logs = {
      stdout: safeProjectPath(this.projectRoot, record.stdout_path),
      stderr: safeProjectPath(this.projectRoot, record.stderr_path),
      combined: safeProjectPath(this.projectRoot, record.combined_log_path),
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
      cwd: safeProjectPath(this.projectRoot, record.cwd),
      logs,
      control: toProcessControlAvailability(canViewLogs),
    };
  }
}
