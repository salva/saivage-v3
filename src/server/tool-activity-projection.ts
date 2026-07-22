import { GLOBAL_ANALYST_SESSION_ID } from '../schemas/index.js';
import { ClassifiedToolInvocationActivityContentSchema, type ClassifiedToolInvocationActivityContent } from '../contracts/operator-events.js';
import type { ToolInvocationProjector, ToolInvocationResult } from '../contracts/tool-invocation-projection.js';
import { projectToolInvocation } from '../tools/tool-invocation-outbound.js';

export interface AnalystToolInvocationActivityInput {
  tool: string;
  params: unknown;
  sourceInputId: string;
  toolCallId: string;
  result: ToolInvocationResult;
}

export function projectAnalystToolInvocationActivity(
  invocation: AnalystToolInvocationActivityInput,
  invocationProjector: ToolInvocationProjector = projectToolInvocation,
): ClassifiedToolInvocationActivityContent {
  const projected = invocationProjector({
    shape: 'complete',
    identity: {
      sessionId: GLOBAL_ANALYST_SESSION_ID,
      sourceInputId: invocation.sourceInputId,
      toolCallId: invocation.toolCallId,
      toolName: invocation.tool,
    },
    arguments: invocation.params,
    result: invocation.result,
  });
  if (projected.shape !== 'complete') throw new Error('WebSocket activity invocation projected to a non-complete shape.');
  return ClassifiedToolInvocationActivityContentSchema.parse({
    event: 'tool_invocation',
    sessionId: GLOBAL_ANALYST_SESSION_ID,
    tool: projected.identity.toolName,
    params: projected.arguments,
    result: narrowActivityResult(projected.result),
  });
}

const ACTIVITY_DATA_KEYS = [
  'classified_as', 'process_id', 'exit_code', 'status', 'duration_ms', 'stdout_url', 'stderr_url',
  'stdout_bytes', 'stderr_bytes', 'command', 'cwd', 'path', 'stash_url', 'binary', 'size', 'modified_at',
] as const;

function narrowActivityResult(result: ToolInvocationResult): ToolInvocationResult {
  if (result.data === null || typeof result.data !== 'object' || Array.isArray(result.data)) return { ...result };
  const source = result.data as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const key of ACTIVITY_DATA_KEYS) if (Object.hasOwn(source, key)) data[key] = source[key];
  return { ...result, data };
}
