import {
  parseToolCallMessageForModel,
  ToolResultSchema,
  validateProcessToolResult,
  type ValidatedConversation,
} from '../contracts/index.js';
import type { AgentMessage } from '../schemas/index.js';

/** Work liveness, not provider composition or a second compaction selection. */
export function* conversationWorkReferences(
  conversation: ValidatedConversation,
): Generator<unknown> {
  const history = conversation.effectiveCompactedHistory;
  if (history) {
    yield history.summaryText;
    for (const prompt of history.protectedPrompts) yield prompt.message.content;
  }
  for (const row of conversation.sourceRows) yield* rowWorkReferences(row);
}

function* rowWorkReferences(row: AgentMessage): Generator<unknown> {
  switch (row.kind) {
    case 'text':
    case 'record_prompt':
    case 'model_repair':
      yield row.content;
      return;
    case 'tool_call':
      yield parseToolCallMessageForModel(JSON.parse(row.content)).arguments;
      return;
    case 'tool_result': {
      const result = ToolResultSchema.parse(JSON.parse(row.content));
      if (!result.success) {
        yield result.error;
        yield result.data;
        return;
      }
      if (
        row.tool === 'run_command' ||
        row.tool === 'wait_process' ||
        row.tool === 'kill_process'
      ) {
        const data = validateProcessToolResult(result.data);
        // The same two stream-liveness conditions as the runtime primary projection.
        const { stdout_url, stderr_url, ...inline } = data;
        yield inline;
        if (data.status === 'running' || !data.stdout_complete) yield stdout_url;
        if (data.status === 'running' || !data.stderr_complete) yield stderr_url;
      } else {
        yield result.data;
        for (const block of result.content ?? [])
          yield block.type === 'text' ? block.text : block.image;
      }
      return;
    }
    case 'activity':
    case 'record_observation':
    case 'model_issue':
    case 'provider_private':
    case 'model_recovered':
    case 'content_policy_refusal':
    case 'content_policy_retry':
      return;
    default: {
      const kind: never = row.kind;
      throw new Error(`Unhandled GC conversation row kind: ${String(kind)}`);
    }
  }
}
