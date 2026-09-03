import type { ConversationSessionId } from '../schemas/index.js';
import { ClassifiedToolInvocationActivityContentSchema, type ClassifiedToolInvocationActivityContent } from '../contracts/operator-events.js';
import type { ToolResult as ToolInvocationResult } from '../contracts/tool-result.js';
import { projectLiveToolInvocation } from '../tools/tool-invocation-outbound.js';

export interface AnalystToolInvocationActivityInput {
  tool: string;
  params: unknown;
  sourceInputId: string;
  toolCallId: string;
  result: ToolInvocationResult;
}

export function projectAnalystToolInvocationActivity(
  invocation: AnalystToolInvocationActivityInput,
  sessionId:ConversationSessionId,
): ClassifiedToolInvocationActivityContent {
  const projected = projectLiveToolInvocation({
    shape: 'complete',
    identity: {
      sessionId,
      sourceInputId: invocation.sourceInputId,
      toolCallId: invocation.toolCallId,
      toolName: invocation.tool,
    },
    arguments: invocation.params,
    result: invocation.result,
  });
  return ClassifiedToolInvocationActivityContentSchema.parse({
    event: 'tool_invocation',
    sessionId,
    tool: projected.identity.toolName,
    params: projected.arguments,
    result: projected.result,
  });
}
