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
            exit_code: data.exit_code,
            duration_ms: data.duration_ms,
            truncated: data.truncated,
            stdout: data.stdout,
            stderr: data.stderr,
            command: data.command,
            cwd: data.cwd,
            path: data.path,
            binary: data.binary,
            size: data.size,
            modified_at: data.modified_at,
          }
        : invocation.result.data,
    }),
  };
}
