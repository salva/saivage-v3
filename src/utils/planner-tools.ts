import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CardRecord, CardStatus, ReviewAssessment, ReviewerIssue, ReviewerResult, RuntimeState } from '../schemas/types.js';
import { CardStore } from './card-store.js';
import { appendNote } from './notes.js';

export type PlannerToolErrorKind =
  | 'subtree_not_ready'
  | 'invalid_evidence'
  | 'terminal_card_requires_restart'
  | 'card_already_active';

export type SubtreeReadinessReason = { kind: 'descendant_blocking'; card_id: string; status: 'blocked' | 'changed' };

export class PlannerToolError extends Error {
  constructor(
    public readonly kind: PlannerToolErrorKind,
    message: string,
    public readonly payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PlannerToolError';
  }
}

export interface GoalSelfReport {
  summary?: string;
  result?: 'done' | 'failed' | 'blocked';
  outcome?: 'done' | 'failed' | 'blocked';
  evidence_card_ids?: string[];
  status_text?: string;
  at?: string;
  [key: string]: unknown;
}

export interface ReportGoalInput {
  status_text: string;
  summary?: string;
  evidence_card_ids?: string[];
  report?: GoalSelfReport;
}

export interface ReportGoalResult {
  card: CardRecord;
  accepted: true;
  assessment?: ReviewAssessment;
}

export interface ReviewerInvoker {
  (goalId: string, assessmentId: string, reviewerSessionId: string, report: GoalSelfReport): Promise<ReviewerResult> | ReviewerResult;
}

export interface PlannerToolsServiceOptions {
  runtimeStateProvider?: () => RuntimeState | null;
  projectRoot?: string;
  reviewer?: ReviewerInvoker;
  maxReviewRetries?: number;
  assessmentIdFactory?: () => string;
}

const TERMINAL_STATUSES = new Set<CardStatus>(['done', 'failed', 'cancelled']);
const CANCELLABLE_STATUSES = new Set<CardStatus>(['backlog', 'active', 'blocked', 'changed']);
const REPORTABLE_OUTCOMES: Record<'report_goal_done' | 'report_goal_failed' | 'report_goal_blocked', Extract<CardStatus, 'done' | 'failed' | 'blocked'>> = {
  report_goal_done: 'done',
  report_goal_failed: 'failed',
  report_goal_blocked: 'blocked',
};

function cloneResult(card: CardRecord): Record<string, unknown> {
  const result = card.result;
  return result && typeof result === 'object' ? { ...result } : {};
}

function requireCard(store: CardStore, cardId: string): CardRecord {
  const card = store.read(cardId);
  if (!card) throw new Error(`Card '${cardId}' not found.`);
  return card;
}

function subtreeContainsActiveLeaf(store: CardStore, state: RuntimeState | null, cardId: string): boolean {
  const activeLeaf = state?.active_card_run?.card_id;
  if (!activeLeaf) return false;
  return activeLeaf === cardId || store.getDescendantIds(cardId).includes(activeLeaf);
}

function hasDurableEvidence(card: CardRecord): boolean {
  if (card.artifacts.length > 0 || card.attachments.length > 0) return true;
  const result = card.result;
  if (!result || typeof result !== 'object') return false;
  if (card.type === 'goal' || card.type === 'project') {
    const review = (result as { review?: unknown }).review;
    return !!review && typeof review === 'object' && (review as { result?: unknown }).result === 'pass';
  }
  return !!(result as { executor?: unknown }).executor || Object.keys(result).length > 0;
}

function assertEvidenceCardsReady(store: CardStore, goalId: string, evidenceCardIds: string[]): void {
  const subtree = new Set([goalId, ...store.getDescendantIds(goalId)]);
  for (const evidenceId of evidenceCardIds) {
    if (!subtree.has(evidenceId)) {
      throw new PlannerToolError('invalid_evidence', `Evidence card '${evidenceId}' is not in the subtree of goal '${goalId}'.`);
    }
    const card = requireCard(store, evidenceId);
    if (card.status !== 'done') {
      throw new PlannerToolError('invalid_evidence', `Evidence card '${evidenceId}' must be done before it can support goal '${goalId}'.`);
    }
    if (!hasDurableEvidence(card)) {
      throw new PlannerToolError('invalid_evidence', `Evidence card '${evidenceId}' has no durable evidence for goal '${goalId}'.`);
    }
  }
}

function collectSubtreeReadinessReasons(store: CardStore, goalId: string): SubtreeReadinessReason[] {
  const reasons: SubtreeReadinessReason[] = [];
  for (const descendantId of store.getDescendantIds(goalId)) {
    const descendant = requireCard(store, descendantId);
    if (descendant.status === 'blocked' || descendant.status === 'changed') {
      reasons.push({ kind: 'descendant_blocking', card_id: descendantId, status: descendant.status });
    }
  }
  return reasons;
}

function normalizeReviewerResult(result: ReviewerResult): ReviewerResult {
  return {
    result: result.result === 'fail' ? 'needs_corrections' : result.result,
    summary: result.summary,
    achieved: result.achieved ?? [],
    issues: result.issues ?? result.missing?.map((summary) => ({ summary, severity: 'blocker' as const })) ?? [],
    evidence_card_ids: result.evidence_card_ids ?? [],
  };
}

export class PlannerToolsService {
  private readonly runtimeStateProvider?: () => RuntimeState | null;
  private readonly projectRoot?: string;
  private readonly reviewer?: ReviewerInvoker;
  private readonly maxReviewRetries: number;
  private readonly assessmentIdFactory: () => string;

  constructor(
    private readonly store: CardStore,
    runtimeStateProviderOrOptions?: (() => RuntimeState | null) | PlannerToolsServiceOptions,
  ) {
    if (typeof runtimeStateProviderOrOptions === 'function') {
      this.runtimeStateProvider = runtimeStateProviderOrOptions;
      this.maxReviewRetries = 3;
      this.assessmentIdFactory = () => randomUUID();
    } else {
      this.runtimeStateProvider = runtimeStateProviderOrOptions?.runtimeStateProvider;
      this.projectRoot = runtimeStateProviderOrOptions?.projectRoot;
      this.reviewer = runtimeStateProviderOrOptions?.reviewer;
      this.maxReviewRetries = runtimeStateProviderOrOptions?.maxReviewRetries ?? 3;
      this.assessmentIdFactory = runtimeStateProviderOrOptions?.assessmentIdFactory ?? (() => randomUUID());
    }
  }

  activateCard(cardId: string): CardRecord {
    const card = requireCard(this.store, cardId);
    const runtimeState = this.runtimeStateProvider?.() ?? null;
    if (runtimeState?.active_card_run?.card_id === cardId) {
      throw new PlannerToolError('card_already_active', `Card '${cardId}' is already the active runtime leaf.`);
    }
    if (card.status === 'active' || card.status === 'running') {
      throw new PlannerToolError('card_already_active', `Card '${cardId}' is already active.`);
    }
    if (TERMINAL_STATUSES.has(card.status)) {
      throw new PlannerToolError('terminal_card_requires_restart', `Card '${cardId}' is terminal and must be restarted before activation.`);
    }
    return this.store.update(cardId, { status: 'active' });
  }

  cancelCard(cardId: string): CardRecord {
    const card = requireCard(this.store, cardId);
    if (!CANCELLABLE_STATUSES.has(card.status)) {
      throw new Error(`Card '${cardId}' in status '${card.status}' cannot be cancelled.`);
    }
    if (subtreeContainsActiveLeaf(this.store, this.runtimeStateProvider?.() ?? null, cardId)) {
      throw new PlannerToolError('card_already_active', `Card '${cardId}' cannot be cancelled while its subtree contains the active runtime leaf.`);
    }
    return this.store.update(cardId, { status: 'cancelled' });
  }

  deleteCard(cardId: string): void {
    const card = requireCard(this.store, cardId);
    if (subtreeContainsActiveLeaf(this.store, this.runtimeStateProvider?.() ?? null, cardId)) {
      throw new PlannerToolError('card_already_active', `Card '${cardId}' cannot be deleted while its subtree contains the active runtime leaf.`);
    }
    if (card.status !== 'cancelled' && !TERMINAL_STATUSES.has(card.status)) {
      throw new Error(`Card '${cardId}' must be cancelled or terminal before deletion.`);
    }
    if (card.status !== 'cancelled') {
      this.store.update(cardId, { status: 'backlog' });
      this.store.update(cardId, { status: 'cancelled' });
    }
    this.store.update(cardId, { status: 'drafting' });
    this.store.delete(cardId);
  }

  restartCard(cardId: string): CardRecord {
    const card = requireCard(this.store, cardId);
    if (subtreeContainsActiveLeaf(this.store, this.runtimeStateProvider?.() ?? null, cardId)) {
      throw new PlannerToolError('card_already_active', `Card '${cardId}' cannot be restarted while its subtree contains the active runtime leaf.`);
    }
    if (!TERMINAL_STATUSES.has(card.status)) {
      throw new Error(`Card '${cardId}' is not terminal and cannot be restarted.`);
    }
    this.store.update(cardId, { status: 'backlog' });
    const changes: Partial<CardRecord> = {
      result: null,
      error: null,
      completed_at: null,
      duration_ms: null,
      retries: 0,
    };
    if (card.type === 'goal' || card.type === 'project') {
      changes.status_text = null;
      changes.status_text_updated_at = null;
      changes.status_text_author_session_id = null;
      changes.latest_self_report = null;
    }
    return this.store.update(cardId, changes);
  }

  reportGoal(toolName: keyof typeof REPORTABLE_OUTCOMES, goalId: string, input: ReportGoalInput, sessionId?: string): ReportGoalResult {
    const result = this.reportGoalSync(toolName, goalId, input, sessionId);
    if (result instanceof Promise) {
      throw new Error('Asynchronous reviewer is not supported by reportGoal(); use reportGoalAsync().');
    }
    return result;
  }

  async reportGoalAsync(toolName: keyof typeof REPORTABLE_OUTCOMES, goalId: string, input: ReportGoalInput, sessionId?: string): Promise<ReportGoalResult> {
    return await this.reportGoalSync(toolName, goalId, input, sessionId);
  }

  private reportGoalSync(toolName: keyof typeof REPORTABLE_OUTCOMES, goalId: string, input: ReportGoalInput, sessionId?: string): ReportGoalResult | Promise<ReportGoalResult> {
    const goal = requireCard(this.store, goalId);
    if ((goal.type !== 'goal' && goal.type !== 'project') || !input.status_text.trim()) {
      throw new Error(`Tool '${toolName}' requires a goal/project card and non-empty status_text.`);
    }
    const evidenceCardIds = input.evidence_card_ids ?? input.report?.evidence_card_ids ?? [];
    if (toolName === 'report_goal_done') {
      const reasons = collectSubtreeReadinessReasons(this.store, goalId);
      if (reasons.length > 0) {
        this.appendSyntheticNote(goalId, `subtree_not_ready: ${reasons.map((r) => `${r.card_id} is ${r.status}`).join(', ')}`);
        throw new PlannerToolError('subtree_not_ready', `Goal '${goalId}' cannot be reported done while descendants are blocked or changed.`, { reasons });
      }
      assertEvidenceCardsReady(this.store, goalId, evidenceCardIds);
    } else if (evidenceCardIds.length > 0) {
      assertEvidenceCardsReady(this.store, goalId, evidenceCardIds);
    }

    const report: GoalSelfReport = {
      ...(input.report ?? {}),
      summary: input.report?.summary ?? input.summary ?? '',
      result: input.report?.result ?? REPORTABLE_OUTCOMES[toolName],
      outcome: input.report?.outcome ?? REPORTABLE_OUTCOMES[toolName],
      evidence_card_ids: evidenceCardIds,
      status_text: input.status_text,
      at: new Date().toISOString(),
    };

    if (toolName === 'report_goal_done' && this.reviewer) {
      const assessmentId = this.assessmentIdFactory();
      const reviewerSessionId = `reviewer:${goalId}:${assessmentId}`;
      const maybeReview = this.reviewer(goalId, assessmentId, reviewerSessionId, report);
      if (maybeReview instanceof Promise) {
        return maybeReview.then((review) => this.applyReviewerAssessment(goal, report, input.status_text, sessionId, assessmentId, reviewerSessionId, review));
      }
      return this.applyReviewerAssessment(goal, report, input.status_text, sessionId, assessmentId, reviewerSessionId, maybeReview);
    }

    const updated = this.acceptReport(goal, toolName, report, input.status_text, sessionId, undefined);
    return { card: updated, accepted: true };
  }

  private applyReviewerAssessment(goal: CardRecord, report: GoalSelfReport, statusText: string, sessionId: string | undefined, assessmentId: string, reviewerSessionId: string, rawReview: ReviewerResult): ReportGoalResult {
    const review = normalizeReviewerResult(rawReview);
    const assessment: ReviewAssessment = {
      ...review,
      assessment_id: assessmentId,
      at: new Date().toISOString(),
      reviewer_session_id: reviewerSessionId,
      goal_card_id: goal.id,
    };
    this.store.update(goal.id, { result: { ...cloneResult(requireCard(this.store, goal.id)), review: assessment } });

    if (assessment.result === 'pass') {
      const updated = this.acceptReport(requireCard(this.store, goal.id), 'report_goal_done', report, statusText, sessionId, assessment);
      return { card: updated, accepted: true, assessment };
    }

    const current = requireCard(this.store, goal.id);
    const attempts = current.retries + 1;
    this.store.update(goal.id, { retries: attempts });
    if (attempts > this.maxReviewRetries) {
      this.writePendingSubtreeCorrectionNotes(goal.id, assessment.issues ?? []);
      const changed = this.store.update(goal.id, { status: 'changed' });
      return { card: changed, accepted: true, assessment };
    }
    return { card: requireCard(this.store, goal.id), accepted: true, assessment };
  }

  private acceptReport(goal: CardRecord, toolName: keyof typeof REPORTABLE_OUTCOMES, report: GoalSelfReport, statusText: string, sessionId: string | undefined, assessment: ReviewAssessment | undefined): CardRecord {
    const result: Record<string, unknown> = { ...cloneResult(goal), latest_self_report: report };
    if (assessment) result.review = assessment;
    return this.store.update(goal.id, {
      status: REPORTABLE_OUTCOMES[toolName],
      retries: 0,
      status_text: statusText,
      status_text_updated_at: new Date().toISOString(),
      status_text_author_session_id: sessionId ?? null,
      latest_self_report: report as Record<string, unknown>,
      result,
    });
  }

  private appendSyntheticNote(cardId: string, content: string): void {
    if (!this.projectRoot) return;
    appendNote(join(this.projectRoot, '.saivage'), cardId, { author: 'runtime', kind: 'directive', content });
  }

  private writePendingSubtreeCorrectionNotes(originId: string, issues: ReviewerIssue[]): void {
    const body = `pending_subtree_correction from ${originId}: ${issues.map((issue) => issue.summary).join('; ')}`;
    const targets = [originId, ...this.store.getAncestors(originId)];
    for (const target of targets) this.appendSyntheticNote(target, body);
  }
}
