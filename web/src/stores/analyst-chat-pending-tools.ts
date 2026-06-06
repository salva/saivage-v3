import type { AgentConversationEntry } from '../api/types';
import { parseToolCallMessage } from '../utils/persistedToolCall';

const MAX_PENDING_TOOL_INVOCATIONS = 12;
const MAX_PENDING_SUMMARY_LENGTH = 200;
const FALLBACK_PENDING_SUMMARY = 'tool invoked';

export interface PendingToolInvocation {
  id: string;
  sessionId: string;
  tool: string;
  classifiedAs?: string | null;
  success: boolean;
  summary: string;
  relatedCardId?: string | null;
}

export function normalizePendingSummary(summary: unknown): string {
  if (typeof summary !== 'string') return FALLBACK_PENDING_SUMMARY;
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (!normalized) return FALLBACK_PENDING_SUMMARY;
  return normalized.slice(0, MAX_PENDING_SUMMARY_LENGTH);
}

export function normalizeToolName(tool: unknown): string {
  if (typeof tool !== 'string') return 'tool';
  const normalized = tool.trim();
  return normalized || 'tool';
}

function buildPendingInvocationId(invocation: Omit<PendingToolInvocation, 'id'>): string {
  return [
    invocation.sessionId,
    invocation.tool,
    invocation.summary,
    invocation.success ? 'ok' : 'error',
    invocation.classifiedAs ?? '',
    invocation.relatedCardId ?? '',
  ].join(':');
}

function toolInvocationMatchesMessage(invocation: PendingToolInvocation, message: AgentConversationEntry): boolean {
  if (message.tool !== invocation.tool) return false;
  if (message.kind === 'tool_call' && message.role === 'assistant') {
    try {
      const call = parseToolCallMessage(JSON.parse(message.content));
      return call.name === invocation.tool;
    } catch {
      return false;
    }
  }
  if ((message.kind === 'tool_result' || message.kind === 'tool_error') && message.role === 'tool') return true;
  return false;
}

export function dedupePendingToolInvocations(
  pending: PendingToolInvocation[],
  sessionId: string,
  fetchedMessages: AgentConversationEntry[],
): PendingToolInvocation[] {
  return pending.filter((invocation) => {
    if (invocation.sessionId !== sessionId) return true;
    return !fetchedMessages.some((message) => toolInvocationMatchesMessage(invocation, message));
  });
}

export function pushPendingToolInvocation(
  pending: PendingToolInvocation[],
  invocation: Omit<PendingToolInvocation, 'id'>,
): PendingToolInvocation[] {
  const normalizedInvocation = {
    ...invocation,
    id: buildPendingInvocationId(invocation),
  } satisfies PendingToolInvocation;
  const next = pending.filter((item) => item.id !== normalizedInvocation.id);
  next.push(normalizedInvocation);
  return next.slice(-MAX_PENDING_TOOL_INVOCATIONS);
}
