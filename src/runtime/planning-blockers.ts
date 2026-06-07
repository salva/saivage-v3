import type { CardRecord, PlannerBlockedResult } from '../schemas/index.js';

export function getBlockedPlanning(card: CardRecord | null): PlannerBlockedResult | null {
  const lifecycleResult = card?.lifecycle.result;
  if (lifecycleResult?.kind === 'planner_blocked') return lifecycleResult;
  if (lifecycleResult?.kind === 'reviewer_pass' && lifecycleResult.planning.kind === 'planner_blocked') return lifecycleResult.planning;
  return null;
}

export function cardHasBlockedPlanning(card: CardRecord | null): boolean {
  return getBlockedPlanning(card) !== null;
}

export function blockedPlanningReason(card: CardRecord | null, planning: PlannerBlockedResult): string {
  return planning.blocked_reason.trim()
    ? planning.blocked_reason
    : (card?.lifecycle.error ?? 'Project planning is blocked; resolve the durable planning blocker before terminal project completion.');
}

export function shouldPreservePrecisePlanningBlocker(card: CardRecord | null, incomingResumeReason: string): boolean {
  if (incomingResumeReason !== 'planner_blocked') return false;
  const planning = getBlockedPlanning(card);
  return planning?.blocker_cause === 'reviewer_unavailable' || planning?.resume_reason === 'reviewer_unavailable' || planning?.resume_reason === 'reviewer_invocation_failed';
}

export function isReviewerCapacityPlanningBlocker(reason: string | null | undefined): boolean {
  const normalized = (reason ?? '').toLowerCase();
  return normalized.includes('reviewer/provider capacity') || normalized.includes('reviewer invocation failed');
}
