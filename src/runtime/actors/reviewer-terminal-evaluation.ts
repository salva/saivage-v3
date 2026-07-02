import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import type { ReviewerResult } from '../../contracts/agent-execution.js';
import type { CardRecord, PlannerDoneResult, ReviewerPassResult } from '../../schemas/index.js';
import { verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import type { CardActivationOutcome, CardActorStorePort } from './card-actor.js';
import type { LLMActorOutcome } from './llm-actor.js';

type ReviewerTerminalEvaluationOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export interface ReviewerTerminalEvaluationInput {
  card: CardRecord;
  candidatePlanning: PlannerDoneResult;
  assessmentId: string;
  sessionId: string;
  outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>;
  store: Pick<CardActorStorePort, 'read' | 'listChildren'>;
}

export function evaluateReviewerTerminalOutcome(input: ReviewerTerminalEvaluationInput): ReviewerTerminalEvaluationOutcome {
  let reviewerResult: ReviewerResult;
  try {
    reviewerResult = verifyTerminalToolOutcome(createReviewerContract(), input.outcome).result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', summary: message, result: { kind: 'planner_failure', error: message } };
  }
  if (reviewerResult.status === 'done') {
    const passResult: ReviewerPassResult = { kind: 'reviewer_pass', planning: input.candidatePlanning, review_summary: reviewerResult.summary, assessment_id: input.assessmentId };
    return { status: 'done', summary: reviewerResult.summary, result: passResult };
  }
  if (reviewerResult.status === 'rework') return correctionOutcome(input.assessmentId, reviewerResult.summary);
  if (reviewerResult.status === 'blocked') return { status: 'blocked', summary: reviewerResult.summary, result: { kind: 'planner_blocked', blocked_reason: reviewerResult.summary, resume_reason: 'reviewer_blocked' } };
  return { status: 'failed', summary: reviewerResult.summary, result: { kind: 'planner_failure', error: reviewerResult.summary } };
}

function correctionOutcome(assessmentId: string, summary: string, issues: Array<Record<string, unknown>> = []): ReviewerTerminalEvaluationOutcome {
  return {
    status: 'blocked',
    summary,
    result: { kind: 'planner_blocked', blocked_reason: summary, resume_reason: 'reviewer_needs_corrections', reviewer_correction: { kind: 'reviewer_correction', assessment_id: assessmentId, summary, issues } },
  };
}
