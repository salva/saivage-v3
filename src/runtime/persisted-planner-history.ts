import { join } from 'node:path';
import type { AgentMessage } from '../schemas/index.js';
import { EventLogger } from '../observability/index.js';
import {
  estimateMessageTokens,
  getSessionMessages,
  replaceSessionMessages,
} from './session-persistence.js';
import type { SessionStamper } from '../contracts/session-stamper.js';

const PLANNER_PERSISTED_HISTORY_COMPACTION_LIMIT_TOKENS = 24000;
const PLANNER_PERSISTED_HISTORY_RECENT_MESSAGE_LIMIT = 24;
const PLANNER_PERSISTED_HISTORY_SNIPPET_LIMIT = 240;

function truncatePersistedPlannerHistorySnippet(content: string): string {
  if (content.length <= PLANNER_PERSISTED_HISTORY_SNIPPET_LIMIT) return content;
  return `${content.slice(0, PLANNER_PERSISTED_HISTORY_SNIPPET_LIMIT)}…[truncated ${content.length - PLANNER_PERSISTED_HISTORY_SNIPPET_LIMIT} chars]`;
}

function buildPersistedPlannerHistoryCompactionMessage(
  sessionId: string,
  messages: AgentMessage[],
  stamp: { round_id: string; message_index: number; block_index: number },
): AgentMessage {
  const roleKindCounts = new Map<string, number>();
  for (const message of messages) {
    const key = `${message.role}/${message.kind}${message.tool ? `/${message.tool}` : ''}`;
    roleKindCounts.set(key, (roleKindCounts.get(key) ?? 0) + 1);
  }
  const recent = messages.slice(-PLANNER_PERSISTED_HISTORY_RECENT_MESSAGE_LIMIT).map((message) => ({
    role: message.role,
    kind: message.kind,
    tool: message.tool ?? null,
    timestamp: message.timestamp,
    content:
      message.kind === 'tool_call' ||
      message.kind === 'tool_result' ||
      message.kind === 'tool_error'
        ? `[${message.kind} content omitted from persisted planner history compaction; current cards/runtime state are authoritative]`
        : truncatePersistedPlannerHistorySnippet(message.content),
  }));
  return {
    id: `msg-${sessionId}-persisted-history-compact-${Date.now()}`,
    session_id: sessionId,
    role: 'system',
    kind: 'context_compaction',
    content:
      '[PERSISTED PLANNER SESSION HISTORY COMPACTED]\n' +
      'This session history exceeded the safe resend budget and was compacted during planner retry. Scheduler-critical facts are preserved in current Goal Context, Goal Evidence Context, card state, runtime activations, and the bounded recent-message summaries below. Older transcript/tool bodies were omitted; re-read cards/files with tools if needed.\n\n' +
      JSON.stringify(
        {
          original_message_count: messages.length,
          original_estimated_tokens: estimateMessageTokens(messages),
          role_kind_counts: Object.fromEntries(roleKindCounts),
          recent_message_summaries: recent,
        },
        null,
        2,
      ),
    round_id: stamp.round_id,
    message_index: stamp.message_index,
    block_index: stamp.block_index,
    timestamp: new Date().toISOString(),
  };
}

export function compactPersistedPlannerHistoryForRetry(input: {
  projectRoot: string;
  plannerSessionId: string;
  sessionStamper: SessionStamper;
  eventLogger: EventLogger;
}): boolean {
  const messages = getSessionMessages(join(input.projectRoot, '.saivage'), input.plannerSessionId);
  if (estimateMessageTokens(messages) < PLANNER_PERSISTED_HISTORY_COMPACTION_LIMIT_TOKENS)
    return false;
  const compacted = buildPersistedPlannerHistoryCompactionMessage(
    input.plannerSessionId,
    messages,
    input.sessionStamper.stampDiagnosticInCurrentRound(input.plannerSessionId),
  );
  replaceSessionMessages(join(input.projectRoot, '.saivage'), input.plannerSessionId, [compacted]);
  input.eventLogger.appendEvent({
    kind: 'runtime_diagnostic',
    phase: 'planner_history_compaction',
    error_message: `Compacted oversized persisted planner history for ${input.plannerSessionId}; original_message_count=${messages.length}; original_estimated_tokens=${estimateMessageTokens(messages)}.`,
  });
  return true;
}
