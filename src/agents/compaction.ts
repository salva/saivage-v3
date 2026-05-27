import type { AgentMessage } from '../schemas/index.js';
import {
  getSessionMessages,
  replaceSessionMessages,
  estimateMessageTokens,
} from './session-persistence.js';

// ── Types ─────────────────────────────────────────────────────

export interface CompactionResult {
  /** Whether compaction was performed */
  compacted: boolean;
  /** Number of messages before compaction */
  messagesBefore: number;
  /** Number of messages after compaction */
  messagesAfter: number;
  /** Token count before compaction */
  tokensBefore: number;
  /** Token count after compaction */
  tokensAfter: number;
  /** Current compaction count for the session */
  compactionCount: number;
  /** Whether max compactions have been reached */
  maxReached: boolean;
  /** Whether fallback (truncation) was used instead of summarization */
  usedFallback: boolean;
  /** Error if compaction failed entirely */
  error?: string;
}

export interface CompactionOptions {
  /** Context window limit in tokens */
  contextLimit: number;
  /** Threshold fraction (0-1). Default 0.8 */
  threshold?: number;
  /** Max compactions. Default 3 */
  maxCompactions?: number;
  /** Summary function to call. If not provided, uses fallback */
  summarizeFn?: (
    messages: AgentMessage[],
  ) => Promise<string>;
  /** Cooldown period between compactions (ms). Default 0 */
  cooldownMs?: number;
}

export interface CompactionState {
  count: number;
  lastCompactionMs: number;
}

// ── In-memory compaction tracking ────────────────────────────

const compactionStates = new Map<string, CompactionState>();

function getCompactionState(sessionId: string): CompactionState {
  let state = compactionStates.get(sessionId);
  if (!state) {
    state = { count: 0, lastCompactionMs: 0 };
    compactionStates.set(sessionId, state);
  }
  return state;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Check whether a session needs compaction based on token count.
 *
 * @param estimatedTokens - Current estimated token count.
 * @param contextLimit - The model's context window limit in tokens.
 * @param threshold - Fraction of context limit to trigger (default 0.8).
 */
export function needsCompaction(
  estimatedTokens: number,
  contextLimit: number,
  threshold: number = 0.8,
): boolean {
  if (contextLimit <= 0) return false;
  return estimatedTokens >= contextLimit * threshold;
}

/**
 * Compact a session's message history.
 *
 * Strategy:
 * 1. If a summarization function is provided, call it with the full
 *    conversation. On success, replace history with summary + directive.
 * 2. If summarization fails or is not available, fall back to keeping
 *    only the most recent keepFraction of messages plus a truncation notice.
 * 3. If max compactions reached, signal termination by returning maxReached=true.
 */
export async function compactSession(
  saivageDir: string,
  sessionId: string,
  options: CompactionOptions,
): Promise<CompactionResult> {
  const maxCompactions = options.maxCompactions ?? 3;
  const threshold = options.threshold ?? 0.8;
  const keepFraction = 0.2;

  const state = getCompactionState(sessionId);

  // Check max compactions
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

  const messages = getSessionMessages(saivageDir, sessionId);
  const tokensBefore = estimateMessageTokens(messages);

  // Check if compaction is actually needed
  if (!needsCompaction(tokensBefore, options.contextLimit, threshold)) {
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

  // Try summarization first
  if (options.summarizeFn) {
    try {
      const summary = await options.summarizeFn(messages);

      // Create a summary message
      const summaryMsg: AgentMessage = {
        id: `msg-${sessionId}-compact-${state.count + 1}`,
        session_id: sessionId,
        role: 'system',
        kind: 'model_repair',
        round_id: `r-compacted-${state.count + 1}`,
        message_index: 0,
        block_index: 0,
        content: `[CONTEXT COMPACTION #${state.count + 1}]\n\n` +
          `The conversation has been summarized to conserve context. ` +
          `Please re-read authoritative state from disk if needed.\n\n` +
          `Summary of previous conversation:\n${summary}`,
        timestamp: new Date().toISOString(),
      };

      // Keep the summary + directive
      resultMessages = [summaryMsg];
    } catch {
      // Summarization failed — use fallback
      usedFallback = true;
      resultMessages = createFallbackMessages(
        sessionId,
        messages,
        keepFraction,
        state.count + 1,
      );
    }
  } else {
    // No summarization function — use fallback
    usedFallback = true;
    resultMessages = createFallbackMessages(
      sessionId,
      messages,
      keepFraction,
      state.count + 1,
    );
  }

  // Write compacted messages
  replaceSessionMessages(saivageDir, sessionId, resultMessages);

  // Update compaction state
  state.count++;
  state.lastCompactionMs = Date.now();
  compactionStates.set(sessionId, state);

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

/**
 * Create fallback messages when summarization fails.
 * Keeps the most recent keepFraction of messages plus a truncation notice.
 */
function createFallbackMessages(
  sessionId: string,
  messages: AgentMessage[],
  keepFraction: number,
  compactionNum: number,
): AgentMessage[] {
  const keepCount = Math.max(1, Math.floor(messages.length * keepFraction));
  const keptMessages = messages.slice(-keepCount);

  const truncationMsg: AgentMessage = {
    id: `msg-${sessionId}-compact-fallback-${compactionNum}`,
    session_id: sessionId,
    role: 'system',
    kind: 'model_repair',
    round_id: `r-compacted-${compactionNum}`,
    message_index: 0,
    block_index: 0,
    content: `[CONTEXT COMPACTION #${compactionNum} — TRUNCATION FALLBACK]\n\n` +
      `The conversation history has been truncated to conserve context. ` +
      `${messages.length - keepCount} older messages were removed. ` +
      `Only the most recent ${keepCount} messages are preserved below. ` +
      `Please re-read authoritative state from disk if you need context from earlier in the conversation.`,
    timestamp: new Date().toISOString(),
  };

  return [truncationMsg, ...keptMessages];
}

/**
 * Reset compaction state for a session (e.g., when session restarts).
 */
export function resetCompactionState(sessionId: string): void {
  compactionStates.delete(sessionId);
}

/**
 * Get the current compaction count for a session.
 */
export function getCompactionCount(sessionId: string): number {
  return compactionStates.get(sessionId)?.count ?? 0;
}

/**
 * Get full compaction state for a session.
 */
export function getCompactionStateForSession(
  sessionId: string,
): CompactionState {
  return getCompactionState(sessionId);
}
