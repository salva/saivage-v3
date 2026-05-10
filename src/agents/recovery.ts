import { EventEmitter } from 'node:events';
import type { RuntimeSection } from './config-schema.js';

// ── Types ─────────────────────────────────────────────────────

/**
 * Result of a single agent invocation attempt.
 */
export interface InvocationAttempt {
  /** Attempt number (1-based) */
  attempt: number;
  /** Whether the attempt succeeded */
  success: boolean;
  /** The result value if successful */
  result?: unknown;
  /** Error if failed */
  error?: Error;
  /** Was this attempt cancelled by analyst request? */
  cancelled?: boolean;
}

/**
 * Recovery context passed to the agent function on retry.
 */
export interface RecoveryContext {
  /** Current attempt number (1-based) */
  attempt: number;
  /** Max attempts remaining */
  maxAttempts: number;
  /** Whether this is a recovery retry */
  isRecovery: boolean;
  /** The error that caused the previous attempt to fail */
  previousError?: Error;
  /** Recovery directive message */
  directive: string;
}

/**
 * Options for the recovery wrapper.
 */
export interface RecoveryOptions {
  /** Delay before retry in milliseconds (default: 60000) */
  recoveryDelayMs?: number;
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Whether to publish events on failures */
  publishEvents?: boolean;
  /** Event emitter for publishing failure events */
  eventBus?: EventEmitter;
  /** Card ID for persisting failure to card notes */
  cardId?: string;
  /** Goal ID for persisting failure to plan diary */
  goalId?: string;
  /** Session ID for associating recovery with a session */
  sessionId?: string;
  /** Agent role for logging/event purposes */
  agentRole?: string;
  /** Custom function to persist failure (card note, plan diary, etc.) */
  persistFailure?: (error: Error, attempt: number, context: RecoveryContext) => void;
  /** Whether to bypass delay on analyst cancel (default: true) */
  analystCancelBypassesDelay?: boolean;
}

/**
 * An agent function that receives recovery context and returns a result.
 */
export type AgentFn<T> = (context: RecoveryContext) => Promise<T>;

// ── Recovery Wrapper ──────────────────────────────────────────

/**
 * Wraps an agent function with recovery logic.
 *
 * On failure:
 * 1. Persists failure to card note or plan diary (if configured).
 * 2. Publishes a runtime event (if event bus configured).
 * 3. Waits recovery delay.
 * 4. Retries with a recovery directive telling the agent to re-read state.
 *
 * @param agentFn - The agent function to wrap.
 * @param options - Recovery configuration.
 * @returns Array of invocation attempts (last one is the final result).
 */
export async function invokeWithRecovery<T>(
  agentFn: AgentFn<T>,
  options: RecoveryOptions = {},
): Promise<InvocationAttempt[]> {
  const {
    recoveryDelayMs = 60000,
    maxRetries = 3,
    publishEvents = false,
    eventBus,
    persistFailure,
  } = options;

  const attempts: InvocationAttempt[] = [];
  const maxAttempts = maxRetries + 1; // initial attempt + retries

  for (let i = 1; i <= maxAttempts; i++) {
    const isRecovery = i > 1;
    const previousError = i > 1 ? attempts[i - 2]?.error : undefined;

    const context: RecoveryContext = {
      attempt: i,
      maxAttempts,
      isRecovery,
      previousError,
      directive: isRecovery
        ? `RECOVERY DIRECTIVE: Your previous invocation failed. ` +
          `Please re-read authoritative state from disk (cards, notes, plan diary) ` +
          `to understand the current state before proceeding. ` +
          `Previous error: ${previousError?.message ?? 'Unknown error'}`
        : '',
    };

    try {
      const result = await agentFn(context);
      const attempt: InvocationAttempt = {
        attempt: i,
        success: true,
        result,
      };
      attempts.push(attempt);

      // Publish success event
      if (publishEvents && eventBus) {
        eventBus.emit('agent_recovered', {
          role: options.agentRole,
          attempt: i,
          sessionId: options.sessionId,
          cardId: options.cardId,
          goalId: options.goalId,
        });
      }

      return attempts;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const attempt: InvocationAttempt = {
        attempt: i,
        success: false,
        error,
      };
      attempts.push(attempt);

      // Persist failure
      if (persistFailure) {
        try {
          persistFailure(error, i, context);
        } catch {
          // Best effort — don't let persistence failure block recovery
        }
      }

      // Publish failure event
      if (publishEvents && eventBus) {
        eventBus.emit('agent_invocation_failed', {
          role: options.agentRole,
          attempt: i,
          error: error.message,
          sessionId: options.sessionId,
          cardId: options.cardId,
          goalId: options.goalId,
          recoverable: i < maxAttempts,
        });
      }

      // If this was the last attempt, we're done
      if (i >= maxAttempts) {
        return attempts;
      }

      // Wait recovery delay before retry
      await delay(recoveryDelayMs);
    }
  }

  return attempts;
}

/**
 * Cancel an ongoing recovery (bypasses delay).
 * This is implemented by setting a cancel flag that the wrapper checks.
 */
export function createCancellableRecovery<T>(
  agentFn: AgentFn<T>,
  options: RecoveryOptions = {},
): {
  invoke: () => Promise<InvocationAttempt[]>;
  cancel: () => void;
} {
  let cancelled = false;

  const wrappedAgentFn: AgentFn<T> = async (context) => {
    if (cancelled) {
      throw new Error('Agent invocation cancelled by analyst request.');
    }
    return agentFn(context);
  };

  // Override recovery delay to be bypassable
  const cancelOptions: RecoveryOptions = {
    ...options,
    recoveryDelayMs: 0, // No delay when analyst cancels
    analystCancelBypassesDelay: true,
  };

  return {
    invoke: () => invokeWithRecovery(wrappedAgentFn, cancelled ? cancelOptions : options),
    cancel: () => {
      cancelled = true;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create default recovery options from runtime config.
 */
export function recoveryOptionsFromConfig(
  runtimeConfig: RuntimeSection,
  overrides?: Partial<RecoveryOptions>,
): RecoveryOptions {
  return {
    recoveryDelayMs: runtimeConfig.recoveryDelayMs ?? 60000,
    maxRetries: runtimeConfig.maxRecoveryRetries ?? 3,
    ...overrides,
  };
}
