import type { ProcessView } from '../../contracts/operator-api-processes.js';
import { redactForOutbound } from '../../redaction/index.js';
import type { ProcessRecord } from '../../runtime/process-runner.js';
import { toContainedRelativePath, workUrlFromAbsolutePath } from '../../workspace/index.js';

export function buildProcessView(projectRoot: string, record: ProcessRecord): ProcessView {
  const safePath = (path: string | null | undefined) => path ? toContainedRelativePath(projectRoot, path) : null;
  const logUrl = (path: string | null | undefined) => path ? workUrlFromAbsolutePath(projectRoot, path) : null;
  const process: ProcessView = {
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
    command: record.command,
    cwd: safePath(record.cwd),
    logs: { stdout: logUrl(record.stdout_path), stderr: logUrl(record.stderr_path) },
  };
  return redactForOutbound({ source: 'process-view', value: process });
}
