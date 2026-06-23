import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import type { ReviewerResult } from '../../contracts/agent-execution.js';
import type { CardRecord, PlannerDoneResult, ReviewAssessment, ReviewerPassResult } from '../../schemas/index.js';
import { validateReviewerAssessment } from '../reviewer-assessment.js';
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
  store: Pick<CardActorStorePort, 'read'>;
}

export function evaluateReviewerTerminalOutcome(input: ReviewerTerminalEvaluationInput): ReviewerTerminalEvaluationOutcome {
  let reviewerResult: ReviewerResult;
  try {
    reviewerResult = verifyTerminalToolOutcome(createReviewerContract(), input.outcome).result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', summary: message, result: { kind: 'planner_failure', error: message } };
  }
  const assessment = buildReviewAssessment(reviewerResult, input.assessmentId, input.sessionId, input.card.id);
  const validation = validateReviewerAssessment({ goalId: input.card.id, assessment, candidatePlannerResult: input.candidatePlanning, readCard: (id) => input.store.read(id) });
  if (!validation.valid) return correctionOutcome(input.assessmentId, validation.reason ?? 'Reviewer assessment is invalid.');
  if (assessment.result === 'needs_corrections') return correctionOutcome(input.assessmentId, assessment.summary, assessment.issues.map((issue) => ({ ...issue })));
  const passResult: ReviewerPassResult = { kind: 'reviewer_pass', planning: input.candidatePlanning, review_summary: assessment.summary, assessment_id: input.assessmentId };
  return { status: 'done', summary: assessment.summary, result: passResult };
}

function correctionOutcome(assessmentId: string, summary: string, issues: Array<Record<string, unknown>> = []): ReviewerTerminalEvaluationOutcome {
  return {
    status: 'blocked',
    summary,
    result: { kind: 'planner_blocked', blocked_reason: summary, resume_reason: 'reviewer_needs_corrections', reviewer_correction: { kind: 'reviewer_correction', assessment_id: assessmentId, summary, issues } },
  };
}

function buildReviewAssessment(result: ReviewerResult, assessmentId: string, sessionId: string, goalId: string): ReviewAssessment {
  const now = new Date().toISOString();
  return { ...result.assessment, assessment_id: assessmentId, at: now, created_at: now, reviewer_session_id: sessionId, goal_card_id: goalId };
}
