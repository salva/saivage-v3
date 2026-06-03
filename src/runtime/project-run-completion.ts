import type { CardRecord, ProjectRunCompletedPayload, ReviewAssessment } from '../schemas/index.js';

export function buildProjectRunCompletedPayload(
  card: CardRecord,
  assessment?: ReviewAssessment,
): ProjectRunCompletedPayload {
  const outcome = card.status === 'blocked' ? 'blocked' : card.status === 'failed' ? 'failed' : 'done';
  const summary = assessment?.summary ?? card.status_text ?? card.error ?? `project ${outcome}`;
  if (outcome === 'blocked') {
    return {
      project_card_id: card.id,
      result: outcome,
      summary,
      blocked_reason: card.error ?? undefined,
    };
  }
  if (outcome === 'failed') {
    return {
      project_card_id: card.id,
      result: outcome,
      summary,
      failure_kind: card.error ?? undefined,
    };
  }
  return { project_card_id: card.id, result: outcome, summary };
}
