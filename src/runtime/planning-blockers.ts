import type { CardRecord } from '../schemas/index.js';

export function getBlockedPlanning(card: CardRecord | null): Record<string, unknown> | null {
  const planning =
    card?.result && typeof card.result === 'object'
      ? (card.result as { planning?: unknown }).planning
      : null;
  if (!planning || typeof planning !== 'object') return null;
  const blockedPlanning = planning as Record<string, unknown>;
  return blockedPlanning.status === 'blocked' ? blockedPlanning : null;
}

export function cardHasBlockedPlanning(card: CardRecord | null): boolean {
  return getBlockedPlanning(card) !== null;
}

export function blockedPlanningReason(card: CardRecord | null, planning: Record<string, unknown>): string {
  return typeof planning.blocked_reason === 'string' && planning.blocked_reason.trim()
    ? planning.blocked_reason
    : (card?.error ?? 'Project planning is blocked; resolve the durable planning blocker before terminal project completion.');
}

export function shouldPreservePrecisePlanningBlocker(card: CardRecord | null, incomingResumeReason: string): boolean {
  if (incomingResumeReason !== 'planner_blocked') return false;
  const planning = getBlockedPlanning(card);
  return planning?.resume_reason === 'reviewer_unavailable' && planning.failure_kind === 'reviewer_invocation_failed';
}

export function isReviewerCapacityPlannerBlocker(blockedReason: string | null | undefined): boolean {
  if (!blockedReason) return false;
  const normalized = blockedReason.toLowerCase();
  return (
    normalized.includes('report_goal_done') &&
    normalized.includes('reviewer') &&
    (normalized.includes('provider capacity') ||
      normalized.includes('capacity is unavailable') ||
      normalized.includes('reviewer/provider capacity') ||
      normalized.includes('reviewer capacity') ||
      normalized.includes('reviewer unavailable'))
  );
}
