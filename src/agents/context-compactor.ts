import type { AgentMessage, OperationalAgentRole, RuntimeState } from '../schemas/index.js';
import { agentMessageSchema } from '../schemas/index.js';
import { generateRoundId } from '../schemas/round-id-server.js';
import { parseToolCallMessage } from '../contracts/persisted-tool-call.js';
import { buildPlannerStateContextMessage, type PlannerStateCardStore } from './planner-state-context.js';
import type { RoundStamp, SessionStamper } from './session-persistence.js';
import { SessionInvariantError } from './session-invariant-error.js';
import {
  getSessionMessages,
  replaceSessionMessages,
  estimateMessageTokens,
} from './session-persistence.js';

export type AgentRole = OperationalAgentRole;

export interface CompactionResult {
  compacted: boolean;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  compactionCount: number;
  maxReached: boolean;
  usedFallback: boolean;
  error?: string;
}

export interface CompactionPolicy {
  contextLimit: number;
  threshold?: number;
  maxCompactions?: number;
  keepFraction?: number;
  cooldownMs?: number;
  summarizeFn?: (messages: AgentMessage[]) => Promise<string>;
}

export interface CompactionState {
  count: number;
  lastCompactionMs: number;
}

export interface ContextCompactorDeps {
  saivageDir: string;
  sessionStamper: SessionStamper;
}

export interface PlannerCompactionParams {
  projectRoot: string;
  goalId: string;
  cardStore: PlannerStateCardStore;
  runtimeStateProvider?: () => RuntimeState | null;
}

const PLANNER_HISTORY_CONTEXT_LIMIT_TOKENS = 24000;
const PLANNER_HISTORY_RECENT_MESSAGE_LIMIT = 16;
const PLANNER_HISTORY_SNIPPET_LIMIT = 240;

function truncatePlannerHistorySnippet(content: string): string {
  if (content.length <= PLANNER_HISTORY_SNIPPET_LIMIT) return content;
  return `${content.slice(0, PLANNER_HISTORY_SNIPPET_LIMIT)}…[truncated ${content.length - PLANNER_HISTORY_SNIPPET_LIMIT} chars]`;
}

function toolCallId(message: AgentMessage): string | null {
  if (typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0) return message.tool_call_id;
  if (message.role === 'assistant' && message.kind === 'tool_call') {
    const parsed = parseToolCallMessage(JSON.parse(message.content));
    return parsed.id;
  }
  return null;
}

interface ToolBoundaryIssue {
  kind: 'orphan_tool_call' | 'orphan_tool_result';
  message_id: string;
  tool_call_id: string | null;
  tool?: string;
}

function findToolBoundaryIssues(messages: AgentMessage[]): ToolBoundaryIssue[] {
  const callIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.kind === 'tool_call') {
      const id = toolCallId(message);
      if (id) callIds.add(id);
    }
  }

  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && (message.kind === 'tool_result' || message.kind === 'tool_error')) {
      const id = toolCallId(message);
      if (id && callIds.has(id)) resultIds.add(id);
    }
  }

  const issues: ToolBoundaryIssue[] = [];
  for (const message of messages) {
    if (message.role === 'tool' && (message.kind === 'tool_result' || message.kind === 'tool_error')) {
      const id = toolCallId(message);
      if (!id || !callIds.has(id)) issues.push({ kind: 'orphan_tool_result', message_id: message.id, tool_call_id: id, tool: message.tool });
    }
    if (message.role === 'assistant' && message.kind === 'tool_call') {
      const id = toolCallId(message);
      if (!id || !resultIds.has(id)) issues.push({ kind: 'orphan_tool_call', message_id: message.id, tool_call_id: id, tool: message.tool });
    }
  }
  return issues;
}

export function pruneToolBoundaryAfterTruncation(messages: AgentMessage[]): AgentMessage[] {
  const callIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.kind === 'tool_call') {
      const id = toolCallId(message);
      if (id) callIds.add(id);
    }
  }

  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && (message.kind === 'tool_result' || message.kind === 'tool_error')) {
      const id = toolCallId(message);
      if (id && callIds.has(id)) resultIds.add(id);
    }
  }

  return messages.filter((message) => {
    if (message.role === 'tool' && (message.kind === 'tool_result' || message.kind === 'tool_error')) {
      const id = toolCallId(message);
      return Boolean(id && callIds.has(id));
    }
    if (message.role === 'assistant' && message.kind === 'tool_call') {
      const id = toolCallId(message);
      return Boolean(id && resultIds.has(id));
    }
    return true;
  });
}

export function assertToolBoundaryIntegrity(messages: AgentMessage[]): void {
  const issues = findToolBoundaryIssues(messages);
  if (issues.length > 0) {
    throw new SessionInvariantError(`Session tool boundary invariant violation: ${JSON.stringify(issues)}`);
  }
}

function isPersistedPlannerTerminalEnvelope(message: AgentMessage): boolean {
  if (message.role !== 'assistant' || message.kind !== 'text') return false;
  try {
    const parsed = JSON.parse(message.content) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { kind?: unknown }).kind === 'result' &&
      typeof (parsed as { payload?: unknown }).payload === 'object' &&
      (parsed as { payload?: unknown }).payload !== null
    );
  } catch {
    return false;
  }
}

export function prunePlannerCompletedInvocationHistory(messages: AgentMessage[]): AgentMessage[] {
  let lastTerminalEnvelopeIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isPersistedPlannerTerminalEnvelope(messages[index])) {
      lastTerminalEnvelopeIndex = index;
      break;
    }
  }
  if (lastTerminalEnvelopeIndex < 0) return messages;
  return messages.slice(lastTerminalEnvelopeIndex + 1);
}

export class ContextCompactor {
  private readonly stateMap = new Map<string, CompactionState>();
  private readonly sessionQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ContextCompactorDeps) {}

  needsCompaction(estimatedTokens: number, policy: CompactionPolicy): boolean {
    if (policy.contextLimit <= 0) return false;
    return estimatedTokens >= policy.contextLimit * (policy.threshold ?? 0.8);
  }

  compactSession(sessionId: string, policy: CompactionPolicy): Promise<CompactionResult> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.compactSessionUnlocked(sessionId, policy));
    this.sessionQueues.set(sessionId, next);
    return next.finally(() => {
      if (this.sessionQueues.get(sessionId) === next) this.sessionQueues.delete(sessionId);
    });
  }

  compactPlannerInMemory(
    sessionId: string,
    messages: AgentMessage[],
    role: AgentRole | undefined,
    policy: CompactionPolicy,
    params: PlannerCompactionParams,
  ): AgentMessage[] {
    if (role !== 'planner') return messages;
    const reusableMessages = prunePlannerCompletedInvocationHistory(messages);
    if (!this.needsCompaction(estimateMessageTokens(reusableMessages), { ...policy, threshold: policy.threshold ?? 1 })) return reusableMessages;
    return [
      this.buildPlannerHistoryCompactionMessage(sessionId, reusableMessages),
      buildPlannerStateContextMessage({
        projectRoot: params.projectRoot,
        sessionId,
        goalId: params.goalId,
        cardStore: params.cardStore,
        runtimeStateProvider: params.runtimeStateProvider,
      }),
      ...this.buildPlannerRecentMessageTail(reusableMessages),
    ];
  }

  pruneToolBoundaryAfterTruncation(messages: AgentMessage[]): AgentMessage[] {
    return pruneToolBoundaryAfterTruncation(messages);
  }

  assertToolBoundaryIntegrity(messages: AgentMessage[]): void {
    assertToolBoundaryIntegrity(messages);
  }

  resetState(sessionId: string): void {
    this.stateMap.delete(sessionId);
  }

  getCompactionCount(sessionId: string): number {
    return this.stateMap.get(sessionId)?.count ?? 0;
  }

  getCompactionStateForSession(sessionId: string): CompactionState {
    return this.getCompactionState(sessionId);
  }

  private getCompactionState(sessionId: string): CompactionState {
    let state = this.stateMap.get(sessionId);
    if (!state) {
      state = { count: 0, lastCompactionMs: 0 };
      this.stateMap.set(sessionId, state);
    }
    return state;
  }

  private async compactSessionUnlocked(sessionId: string, policy: CompactionPolicy): Promise<CompactionResult> {
    const maxCompactions = policy.maxCompactions ?? 3;
    const keepFraction = policy.keepFraction ?? 0.2;
    const state = this.getCompactionState(sessionId);

    if (state.count >= maxCompactions) {
      return {
        compacted: false,
        messagesBefore: 0,
        messagesAfter: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        compactionCount: state.count,
        maxReached: true,
        usedFallback: false,
      };
    }

    const nowMs = Date.now();
    if (policy.cooldownMs && state.lastCompactionMs > 0 && nowMs - state.lastCompactionMs < policy.cooldownMs) {
      const messages = getSessionMessages(this.deps.saivageDir, sessionId);
      const tokens = estimateMessageTokens(messages);
      return {
        compacted: false,
        messagesBefore: messages.length,
        messagesAfter: messages.length,
        tokensBefore: tokens,
        tokensAfter: tokens,
        compactionCount: state.count,
        maxReached: false,
        usedFallback: false,
      };
    }

    const messages = getSessionMessages(this.deps.saivageDir, sessionId);
    const tokensBefore = estimateMessageTokens(messages);
    if (!this.needsCompaction(tokensBefore, policy)) {
      return {
        compacted: false,
        messagesBefore: messages.length,
        messagesAfter: messages.length,
        tokensBefore,
        tokensAfter: tokensBefore,
        compactionCount: state.count,
        maxReached: false,
        usedFallback: false,
      };
    }

    let usedFallback = false;
    let resultMessages: AgentMessage[];
    const compactionNum = state.count + 1;

    if (policy.summarizeFn) {
      try {
        const summary = await policy.summarizeFn(messages);
        resultMessages = [this.createCompactionMessage(
          sessionId,
          this.deps.sessionStamper.stampCompacted(sessionId),
          `msg-${sessionId}-compact-${compactionNum}`,
          `[CONTEXT COMPACTION #${compactionNum}]

The conversation has been summarized to conserve context. Inspect authoritative cards, notes, runtime state, and files with tools as needed.

Summary of previous conversation:
${summary}`,
        )];
      } catch {
        usedFallback = true;
        resultMessages = this.createFallbackMessages(sessionId, messages, keepFraction, compactionNum, this.deps.sessionStamper.stampCompacted(sessionId));
      }
    } else {
      usedFallback = true;
      resultMessages = this.createFallbackMessages(sessionId, messages, keepFraction, compactionNum, this.deps.sessionStamper.stampCompacted(sessionId));
    }

    replaceSessionMessages(this.deps.saivageDir, sessionId, resultMessages);
    state.count++;
    state.lastCompactionMs = Date.now();
    this.stateMap.set(sessionId, state);
    const tokensAfter = estimateMessageTokens(resultMessages);

    return {
      compacted: true,
      messagesBefore: messages.length,
      messagesAfter: resultMessages.length,
      tokensBefore,
      tokensAfter,
      compactionCount: state.count,
      maxReached: state.count >= maxCompactions,
      usedFallback,
    };
  }

  private createCompactionMessage(sessionId: string, stamp: RoundStamp, id: string, content: string): AgentMessage {
    return agentMessageSchema.parse({
      id,
      session_id: sessionId,
      role: 'system',
      kind: 'context_compaction',
      round_id: stamp.round_id,
      message_index: stamp.message_index,
      block_index: stamp.block_index,
      content,
      timestamp: new Date().toISOString(),
    });
  }

  private createFallbackMessages(
    sessionId: string,
    messages: AgentMessage[],
    keepFraction: number,
    compactionNum: number,
    stamp: RoundStamp,
  ): AgentMessage[] {
    const keepCount = Math.max(1, Math.floor(messages.length * keepFraction));
    const initialTail = messages.slice(-keepCount);
    const keptMessages = pruneToolBoundaryAfterTruncation(initialTail);

    return [this.createCompactionMessage(
      sessionId,
      stamp,
      `msg-${sessionId}-compact-fallback-${compactionNum}`,
      `[CONTEXT COMPACTION #${compactionNum} — TRUNCATION FALLBACK]

The conversation history has been truncated to conserve context. ${messages.length - keptMessages.length} older messages were removed. Only the most recent ${keptMessages.length} messages are preserved below. Inspect authoritative cards, notes, runtime state, and files with tools if you need context from earlier in the conversation.`,
    ), ...keptMessages];
  }

  private buildPlannerHistoryCompactionMessage(sessionId: string, messages: AgentMessage[]): AgentMessage {
    const roleKindCounts = new Map<string, number>();
    for (const message of messages) {
      const key = `${message.role}/${message.kind}${message.tool ? `/${message.tool}` : ''}`;
      roleKindCounts.set(key, (roleKindCounts.get(key) ?? 0) + 1);
    }
    const recent = messages.slice(-PLANNER_HISTORY_RECENT_MESSAGE_LIMIT).map((message) => ({
      role: message.role,
      kind: message.kind,
      tool: message.tool ?? null,
      timestamp: message.timestamp,
      content:
        message.kind === 'tool_call' || message.kind === 'tool_result' || message.kind === 'tool_error'
          ? `[${message.kind} content omitted from compacted planner history; current card state and unresolved activations are authoritative]`
          : truncatePlannerHistorySnippet(message.content),
    }));
    return {
      id: `msg-${sessionId}-planner-history-compact-in-memory`,
      session_id: sessionId,
      role: 'system',
      kind: 'context_compaction',
      content:
        '[PLANNER SESSION HISTORY COMPACTED IN MEMORY]\n' +
        'Planner session history was compacted. Continue from the reconstructed context below. The structured state message is authoritative for current card/runtime state. Do not rely on earlier transcript content for current child state. The last real messages follow for immediate continuity.\n\n' +
        JSON.stringify(
          {
            original_message_count: messages.length,
            original_estimated_tokens: estimateMessageTokens(messages),
            role_kind_counts: Object.fromEntries(roleKindCounts),
            recent_message_tail_preview: recent,
          },
          null,
          2,
        ),
      round_id: generateRoundId('diagnostic'),
      message_index: 0,
      block_index: 0,
      timestamp: new Date().toISOString(),
    };
  }

  private buildPlannerRecentMessageTail(messages: AgentMessage[]): AgentMessage[] {
    return messages
      .filter((message) => message.kind !== 'context_compaction')
      .slice(-PLANNER_HISTORY_RECENT_MESSAGE_LIMIT)
      .map((message, index) => ({
        ...message,
        id: `${message.id}-planner-tail-in-memory`,
        content: truncatePlannerHistorySnippet(message.content),
        message_index: index + 2,
      }));
  }
}
