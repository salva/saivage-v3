import type { CardRecord, CardLifecycleState, PlannerDoneResult, ReviewAssessment } from '../schemas/index.js';

export function nextReviewerAssessmentId(goalId: string, existingResult: CardLifecycleState['result'] | undefined): string {
  const escapedGoal = goalId.replace(/[^A-Za-z0-9_.:-]/g, '-');
  const prior = existingResult?.kind === 'reviewer_pass' ? existingResult.assessment_id : '';
  const match = prior.match(new RegExp(`^assessment-${escapedGoal}-(\\d+)$`));
  const next = match ? Number(match[1]) + 1 : 1;
  return `assessment-${escapedGoal}-${next}`;
}

export function reviewerSessionId(goalId: string, assessmentId: string): string {
  return `reviewer:${goalId}:${assessmentId}`;
}

export function buildReviewAssessment(input: {
  goalId: string;
  assessmentId: string;
  reviewerSessionId: string;
  result: Pick<ReviewAssessment, 'result' | 'summary' | 'achieved' | 'issues' | 'evidence_card_ids'>;
  nowIso: string;
  override?: Partial<Pick<ReviewAssessment, 'result' | 'summary' | 'achieved' | 'issues' | 'evidence_card_ids'>>;
}): ReviewAssessment {
  const { goalId, assessmentId, reviewerSessionId: sessionId, result, nowIso, override } = input;
  return {
    id: `review:${goalId}:${assessmentId}`,
    goal_card_id: goalId,
    reviewer_session_id: sessionId,
    assessment_id: assessmentId,
    at: nowIso,
    result: override?.result ?? result.result,
    summary: override?.summary ?? result.summary,
    achieved: override?.achieved ?? result.achieved,
    issues: override?.issues ?? result.issues,
    evidence_card_ids: override?.evidence_card_ids ?? result.evidence_card_ids,
    created_at: nowIso,
  };
}

export function validateReviewerAssessment(input: {
  goalId: string;
  assessment: Pick<ReviewAssessment, 'result' | 'summary' | 'achieved' | 'issues' | 'evidence_card_ids'>;
  candidatePlannerResult: PlannerDoneResult;
  readCard(evidenceId: string): CardRecord | null | undefined;
  isDescendantOf(evidenceId: string, goalId: string): boolean;
}): { valid: boolean; reason?: string } {
  const { goalId, assessment, readCard } = input;
  if (assessment.evidence_card_ids.length === 0) {
    return { valid: false, reason: 'Reviewer assessment must cite at least one evidence_card_id.' };
  }
  if (input.candidatePlannerResult.kind !== 'planner_done') {
    return { valid: false, reason: 'Reviewer assessment can only approve a candidate planner_done result.' };
  }
  for (const evidenceId of assessment.evidence_card_ids) {
    const card = readCard(evidenceId);
    if (!card) return { valid: false, reason: `Reviewer cited missing evidence card '${evidenceId}'.` };
    if (!input.isDescendantOf(evidenceId, goalId)) {
      return { valid: false, reason: `Reviewer cited card '${evidenceId}' outside the reviewed subtree.` };
    }
    if (card.status !== 'done') {
      return { valid: false, reason: `Reviewer cited non-accepted card '${evidenceId}' with status '${card.status}'.` };
    }
  }
  return { valid: true };
}
