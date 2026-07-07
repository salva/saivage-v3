import { sanitizeAnalystPayload } from '../agents/analyst-api.js';

export interface AnalystToolInvocationActivityInput {
  tool: string;
  params: unknown;
  result: {
    success: boolean;
    error?: unknown;
    data?: unknown;
  };
}

export function projectAnalystToolInvocationActivity(invocation: AnalystToolInvocationActivityInput): Record<string, unknown> {
  const data = invocation.result.data as Record<string, unknown> | undefined;
  return {
    event: 'tool_invocation',
    tool: invocation.tool,
    params: sanitizeAnalystPayload(invocation.params),
    result: sanitizeAnalystPayload({
      success: invocation.result.success,
      error: invocation.result.error,
      data: data && typeof data === 'object'
        ? {
            classified_as: data.classified_as,
            process_id: data.process_id,
            exit_code: data.exit_code,
            status: data.status,
            duration_ms: data.duration_ms,
            stdout_url: data.stdout_url,
            stderr_url: data.stderr_url,
            stdout_bytes: data.stdout_bytes,
            stderr_bytes: data.stderr_bytes,
            stdout_tail: data.stdout_tail,
            stderr_tail: data.stderr_tail,
            tail_truncated: data.tail_truncated,
            command: data.command,
            cwd: data.cwd,
            path: data.path,
            stash_url: data.stash_url,
            binary: data.binary,
            size: data.size,
            modified_at: data.modified_at,
          }
        : invocation.result.data,
    }),
  };
}
