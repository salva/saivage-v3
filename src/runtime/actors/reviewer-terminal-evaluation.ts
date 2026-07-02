import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import type { ReviewerResult } from '../../contracts/agent-execution.js';
import { verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import type { CardActivationOutcome } from './card-actor.js';
import type { LLMActorOutcome } from './llm-actor.js';

type ReviewerTerminalEvaluationOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export interface ReviewerTerminalEvaluationInput {
  outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>;
}

export function evaluateReviewerTerminalOutcome(input: ReviewerTerminalEvaluationInput): ReviewerTerminalEvaluationOutcome {
  let reviewerResult: ReviewerResult;
  try {
    reviewerResult = verifyTerminalToolOutcome(createReviewerContract(), input.outcome).result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', summary: message, result: { kind: 'failed', summary: message } };
  }
  if (reviewerResult.status === 'done') {
    return { status: 'done', summary: reviewerResult.summary, result: { kind: 'done', summary: reviewerResult.summary } };
  }
  if (reviewerResult.status === 'rework') return correctionOutcome(reviewerResult.summary);
  if (reviewerResult.status === 'blocked') return { status: 'blocked', summary: reviewerResult.summary, result: { kind: 'blocked', summary: reviewerResult.summary, resume_reason: 'reviewer_blocked' } };
  return { status: 'failed', summary: reviewerResult.summary, result: { kind: 'failed', summary: reviewerResult.summary } };
}

function correctionOutcome(summary: string): ReviewerTerminalEvaluationOutcome {
  return {
    status: 'blocked',
    summary,
    result: { kind: 'rework', summary },
  };
}
