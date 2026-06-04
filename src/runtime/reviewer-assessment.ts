import type { CardRecord, CardLifecycleState, ReviewAssessment } from '../schemas/index.js';
import type { ReviewerResult } from '../contracts/index.js';

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
  result: ReviewerResult['assessment'];
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
  assessment: ReviewerResult['assessment'];
  readCard(evidenceId: string): CardRecord | null | undefined;
}): { valid: boolean; reason?: string } {
  const { goalId, assessment, readCard } = input;
  if (assessment.evidence_card_ids.length === 0) {
    return { valid: false, reason: 'Reviewer assessment must cite at least one evidence_card_id.' };
  }
  for (const evidenceId of assessment.evidence_card_ids) {
    const card = readCard(evidenceId);
    if (!card) return { valid: false, reason: `Reviewer cited missing evidence card '${evidenceId}'.` };
    if (evidenceId !== goalId && card.status !== 'done') {
      return { valid: false, reason: `Reviewer cited non-complete evidence card '${evidenceId}' with status '${card.status}'.` };
    }
    if ((card.artifacts?.length ?? 0) === 0 && (card.attachments?.length ?? 0) === 0 && !card.lifecycle.result) {
      return { valid: false, reason: `Reviewer cited card '${evidenceId}' without durable result, artifact, or attachment evidence.` };
    }
  }
  return { valid: true };
}
