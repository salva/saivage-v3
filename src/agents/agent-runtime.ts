import type {
  PlannerResult,
  ExecutorResult,
  ReviewerResult,
} from './result-parser.js';
import type { AgentMessage, HandoffSummary } from '../schemas/types.js';

export interface AgentRuntime {
  invokePlanner(
    goalId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): PlannerResult | Promise<PlannerResult>;

  invokeExecutor(
    cardId: string,
    goalId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): ExecutorResult | Promise<ExecutorResult>;

  invokeReviewer(
    goalId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
    options?: { assessmentId?: string; reviewerSessionId?: string },
  ): ReviewerResult | Promise<ReviewerResult>;

  reinvokeSession?(
    sessionId: string,
    systemPrompt?: string,
    contextMessages?: AgentMessage[],
  ): Promise<ExecutorResult | ReviewerResult> | ExecutorResult | ReviewerResult;

  cancelSession(sessionId: string): boolean | Promise<boolean>;
  forceCancelSession(sessionId: string): boolean | Promise<boolean>;
  getHandoffSummary(sessionId: string): HandoffSummary | null | Promise<HandoffSummary | null>;
  getActiveSessionHandoffs(): HandoffSummary[] | Promise<HandoffSummary[]>;
}
