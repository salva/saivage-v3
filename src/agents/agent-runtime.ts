/**
 * AgentRuntime — Common interface that both FakeAgentAdapter and
 * AgentAdapter implement, so the Runtime can use either one.
 *
 * Methods return union types (T | Promise<T>) so synchronous
 * fake implementations and asynchronous real-LLM implementations
 * are both compatible with the same interface.
 */

import type {
  PlannerResult,
  ExecutorResult,
  ReviewerResult,
} from './result-parser.js';
import type { AgentMessage } from '../schemas/types.js';

/**
 * Common interface for agent invocation, implemented by both
 * FakeAgentAdapter (sync fixtures) and AgentAdapter (real LLM calls).
 *
 * All `systemPrompt` and `contextMessages` parameters are optional so
 * fake adapters can ignore them while real adapters use them.
 */
export interface AgentRuntime {
  /**
   * Invoke the planner agent for a goal.
   *
   * @param goalId       The goal card ID
   * @param planCardId   Optional plan card ID (passed by real adapter, ignored by fake)
   * @param systemPrompt Optional system prompt (ignored by fake adapter)
   * @param contextMessages Optional context messages (ignored by fake adapter)
   */
  invokePlanner(
    goalId: string,
    planCardId?: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): PlannerResult | Promise<PlannerResult>;

  /**
   * Invoke the executor agent for a terminal card.
   *
   * @param cardId       The card to execute
   * @param goalId       The parent goal ID
   * @param systemPrompt Optional system prompt (ignored by fake adapter)
   * @param contextMessages Optional context messages (ignored by fake adapter)
   */
  invokeExecutor(
    cardId: string,
    goalId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): ExecutorResult | Promise<ExecutorResult>;

  /**
   * Invoke the reviewer agent for a goal.
   *
   * @param goalId       The goal card ID
   * @param planCardId   Optional plan card ID (passed by real adapter, ignored by fake)
   * @param systemPrompt Optional system prompt (ignored by fake adapter)
   * @param contextMessages Optional context messages (ignored by fake adapter)
   */
  invokeReviewer(
    goalId: string,
    planCardId?: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): ReviewerResult | Promise<ReviewerResult>;

  /**
   * Request a graceful cancellation of an in-flight agent session.
   * For the real AgentAdapter, this sends an abort signal to the LLM call's
   * AbortController. Returns true if the session was found and cancellation
   * was initiated, false if the session was not tracked.
   */
  cancelSession(sessionId: string): boolean | Promise<boolean>;

  /**
   * Force-cancel an agent session — a stronger signal than cancelSession.
   * Used when the agent hasn't stopped after the force-cancel timeout.
   * Returns true if the session was found and force-cancel was initiated,
   * false otherwise.
   */
  forceCancelSession(sessionId: string): boolean | Promise<boolean>;
}
