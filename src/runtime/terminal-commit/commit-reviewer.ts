import type { CardLifecycleState, CardRecord, PlannerBlockedResult, PlannerDoneResult, ReviewerCorrectionResult, ReviewerPassResult } from '../../schemas/index.js';
import { lifecyclePatch } from './lifecycle-patch.js';
import type { TerminalCommitEffects, TerminalCommitReceipt } from './commit-executor.js';
import { validateTerminalOverlay } from './validators.js';

export async function commitReviewerPass(input: {
  card: CardRecord;
  planning?: PlannerDoneResult | PlannerBlockedResult;
  reviewSummary: string;
  assessmentId: string;
  completedAt: string;
  transitionDetails?: Record<string, unknown>;
  effects: TerminalCommitEffects;
}): Promise<TerminalCommitReceipt<Extract<CardLifecycleState, { status: 'done' }>, ReviewerPassResult>> {
  const result: ReviewerPassResult = { kind: 'reviewer_pass', planning: input.planning ?? reviewerPassPlanningFallback(input.card, input.reviewSummary), review_summary: input.reviewSummary, assessment_id: input.assessmentId };
  const lifecycle = { status: 'done', result, error: null, completed_at: input.completedAt } satisfies Extract<CardLifecycleState, { status: 'done' }>;
  assertNoTerminalOverlayErrors(input.card, lifecycle);
  const transitioned = input.card.status === 'done'
    ? true
    : await input.effects.transitionCard(input.card.id, 'complete', input.transitionDetails ?? { assessment_id: input.assessmentId });
  const patch = { ...lifecyclePatch(lifecycle), result: { ...result, planning: legacyPlanningProjection(result.planning, input.reviewSummary) }, status_text: input.reviewSummary };
  await input.effects.updateCard(input.card.id, patch);
  return { lifecycle, result, patch, transitioned: transitioned !== false };
}

export async function commitReviewerCorrection(input: {
  card: CardRecord;
  issues: Array<Record<string, unknown>>;
  summary: string;
  assessmentId: string;
  effects?: Pick<TerminalCommitEffects, 'transitionCard'>;
}): Promise<{ result: ReviewerCorrectionResult; transitioned: boolean }> {
  const result: ReviewerCorrectionResult = { kind: 'reviewer_correction', issues: input.issues, summary: input.summary, assessment_id: input.assessmentId };
  const transitioned = input.effects
    ? await input.effects.transitionCard(input.card.id, 'reviewer_repair_resume', { assessment_id: input.assessmentId })
    : true;
  return { result, transitioned: transitioned !== false };
}

function assertNoTerminalOverlayErrors(card: CardRecord, lifecycle: CardLifecycleState): void {
  const diagnostics = validateTerminalOverlay(card, lifecycle);
  if (diagnostics.length > 0) throw new Error(`Invalid terminal lifecycle overlay: ${diagnostics.join(' ')}`);
}

function reviewerPassPlanningFallback(card: CardRecord, reviewSummary: string): PlannerDoneResult | PlannerBlockedResult {
  const result = card.result;
  if (isPlannerDoneResult(result) || isPlannerBlockedResult(result)) return result;
  if (isReviewerPassResult(result)) return result.planning;

  const planning = result && typeof result === 'object' && 'planning' in result ? (result as { planning?: unknown }).planning : null;
  if (planning && typeof planning === 'object') {
    const record = planning as Record<string, unknown>;
    const createdCards = stringArray(record.created_cards);
    const updatedCards = stringArray(record.updated_cards);
    if (record.status === 'blocked') {
      return {
        kind: 'planner_blocked',
        blocked_reason: typeof record.blocked_reason === 'string' && record.blocked_reason ? record.blocked_reason : 'Reviewer pass preserved blocked planning context.',
        resume_reason: typeof record.resume_reason === 'string' && record.resume_reason ? record.resume_reason : 'reviewer_pass',
        created_cards: createdCards,
        updated_cards: updatedCards,
      };
    }
    return {
      kind: 'planner_done',
      created_cards: createdCards,
      updated_cards: updatedCards,
      summary: typeof record.summary === 'string' ? record.summary : reviewSummary,
    };
  }

  return { kind: 'planner_done', created_cards: [], updated_cards: [], summary: reviewSummary };
}

function isPlannerDoneResult(result: unknown): result is PlannerDoneResult {
  return !!result && typeof result === 'object' && (result as { kind?: unknown }).kind === 'planner_done';
}

function isPlannerBlockedResult(result: unknown): result is PlannerBlockedResult {
  return !!result && typeof result === 'object' && (result as { kind?: unknown }).kind === 'planner_blocked';
}

function isReviewerPassResult(result: unknown): result is ReviewerPassResult {
  return !!result && typeof result === 'object' && (result as { kind?: unknown }).kind === 'reviewer_pass' && 'planning' in result;
}

function legacyPlanningProjection(planning: PlannerDoneResult | PlannerBlockedResult, fallbackSummary: string): Record<string, unknown> {
  if (planning.kind === 'planner_blocked') {
    return {
      kind: planning.kind,
      status: 'blocked',
      blocked_reason: planning.blocked_reason,
      resume_reason: planning.resume_reason,
      created_cards: planning.created_cards,
      updated_cards: planning.updated_cards,
    };
  }
  return {
    kind: planning.kind,
    status: 'done',
    created_cards: planning.created_cards,
    updated_cards: planning.updated_cards,
    summary: planning.summary || fallbackSummary,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
