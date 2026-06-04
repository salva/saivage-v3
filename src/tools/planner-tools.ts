import { randomUUID } from 'node:crypto';
import type {
  CardRecord,
  CardStatus,
  ReviewAssessment,
  ReviewerIssue,
  ReviewerResult,
  RuntimeState,
} from '../schemas/index.js';
import type { CardLifecycleState } from '../schemas/index.js';
import type { Recipient } from '../notifications/index.js';
import { decide } from '../permissions/index.js';
import { CardStore } from '../cards/store-api.js';
import { recordControlAction, stableStringify } from '../persistence/index.js';
import { queueNotification } from '../notifications/index.js';
import type { CardMutationContext } from '../cards/store-api.js';
import { lifecycleCardPatch } from '../runtime/terminal-commit/lifecycle-patch.js';

export type PlannerToolErrorKind =
  | 'subtree_not_ready'
  | 'invalid_evidence'
  | 'terminal_card_requires_restart'
  | 'card_already_active'
  | 'invalid_card_status'
  | 'reviewer_invocation_failed';

export type SubtreeReadinessReason = {
  kind: 'descendant_blocking';
  card_id: string;
  status: 'blocked' | 'changed';
};

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
  (
    goalId: string,
    assessmentId: string,
    reviewerSessionId: string,
    report: GoalSelfReport,
    parentSessionId?: string,
  ): Promise<ReviewerResult> | ReviewerResult;
}

export interface PlannerToolsServiceOptions {
  runtimeStateProvider?: () => RuntimeState | null;
  projectRoot?: string;
  reviewer?: ReviewerInvoker;
  maxReviewRetries?: number;
  assessmentIdFactory?: () => string;
}

const REPORTABLE_OUTCOMES: Record<
  'report_goal_done' | 'report_goal_failed' | 'report_goal_blocked',
  Extract<CardStatus, 'done' | 'failed' | 'blocked'>
> = {
  report_goal_done: 'done',
  report_goal_failed: 'failed',
  report_goal_blocked: 'blocked',
};

function requireCard(store: CardStore, cardId: string): CardRecord {
  const card = store.read(cardId);
  if (!card) throw new Error(`Card '${cardId}' not found.`);
  return card;
}

function isGoalLike(card: CardRecord): boolean {
  return card.type === 'goal' || card.type === 'project';
}

function subtreeContainsActiveLeaf(
  store: CardStore,
  state: RuntimeState | null,
  cardId: string,
): boolean {
  const activeLeaf = state?.active_card_run?.card_id;
  if (!activeLeaf) return false;
  return activeLeaf === cardId || store.getDescendantIds(cardId).includes(activeLeaf);
}

function hasDurableEvidence(card: CardRecord): boolean {
  if (card.artifacts.length > 0 || card.attachments.length > 0) return true;
  const result = card.lifecycle.result;
  if (!result || typeof result !== 'object') return false;
  if (card.type === 'goal' || card.type === 'project') {
    const review = (result as { review?: unknown }).review;
    return (
      !!review && typeof review === 'object' && (review as { result?: unknown }).result === 'pass'
    );
  }
  return !!(result as { executor?: unknown }).executor || Object.keys(result).length > 0;
}

function reviewerInvocationFailedMessage(goalId: string): string {
  return `Reviewer invocation failed before assessment output could be produced for goal '${goalId}'; reviewer/provider capacity is unavailable for terminal acceptance.`;
}

function reportLifecycle(status: Extract<CardStatus, 'done' | 'failed' | 'blocked'>, report: GoalSelfReport, statusText: string, completedAt: string): CardLifecycleState {
  if (status === 'done') {
    return {
      status,
      result: { kind: 'planner_done', created_cards: [], updated_cards: [], summary: report.summary ?? statusText },
      error: null,
      completed_at: completedAt,
    };
  }
  if (status === 'blocked') {
    return {
      status,
      result: { kind: 'planner_blocked', blocked_reason: statusText, resume_reason: 'planner_report_blocked', created_cards: [], updated_cards: [] },
      error: statusText,
      completed_at: null,
    };
  }
  return {
    status,
    result: {
      kind: 'executor_failure',
      error: statusText,
      partial_result: report,
      latest_self_report: {
        result: 'failed',
        outcome: 'failed',
        summary: report.summary ?? statusText,
        status_text: statusText,
        at: completedAt,
      },
    },
    error: statusText,
    completed_at: completedAt,
  };
}

function assertEvidenceCardsReady(
  store: CardStore,
  goalId: string,
  evidenceCardIds: string[],
): void {
  const subtree = new Set([goalId, ...store.getDescendantIds(goalId)]);
  for (const evidenceId of evidenceCardIds) {
    if (!subtree.has(evidenceId)) {
      throw new PlannerToolError(
        'invalid_evidence',
        `Evidence card '${evidenceId}' is not in the subtree of goal '${goalId}'.`,
      );
    }
    const card = requireCard(store, evidenceId);
    if (card.status !== 'done') {
      throw new PlannerToolError(
        'invalid_evidence',
        `Evidence card '${evidenceId}' must be done before it can support goal '${goalId}'.`,
      );
    }
    if (!hasDurableEvidence(card)) {
      throw new PlannerToolError(
        'invalid_evidence',
        `Evidence card '${evidenceId}' has no durable evidence for goal '${goalId}'.`,
      );
    }
  }
}

function collectSubtreeReadinessReasons(
  store: CardStore,
  goalId: string,
): SubtreeReadinessReason[] {
  const reasons: SubtreeReadinessReason[] = [];
  for (const descendantId of store.getDescendantIds(goalId)) {
    const descendant = requireCard(store, descendantId);
    if (descendant.status === 'blocked' || descendant.status === 'changed') {
      reasons.push({
        kind: 'descendant_blocking',
        card_id: descendantId,
        status: descendant.status,
      });
    }
  }
  return reasons;
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
      this.assessmentIdFactory =
        runtimeStateProviderOrOptions?.assessmentIdFactory ?? (() => randomUUID());
    }
  }

  activateCard(cardId: string): CardRecord {
    const card = requireCard(this.store, cardId);
    const runtimeState = this.runtimeStateProvider?.() ?? null;
    if (runtimeState?.active_card_run?.card_id === cardId) {
      throw new PlannerToolError(
        'card_already_active',
        `Card '${cardId}' is already the active runtime leaf.`,
      );
    }
    if (card.status === 'active' || card.status === 'running') {
      throw new PlannerToolError('card_already_active', `Card '${cardId}' is already active.`);
    }
    const startDecision = decide({
      role: 'planner',
      action: 'card.start',
      targetState: card.status,
    });
    if (!startDecision.allowed && !isGoalLike(card)) {
      throw new PlannerToolError(
        'terminal_card_requires_restart',
        `Card '${cardId}' is terminal and must be restarted before activation.`,
      );
    }
    return this.store.setStatus(cardId, 'active');
  }

  cancelCard(cardId: string): CardRecord {
    const card = requireCard(this.store, cardId);
    if (!decide({ role: 'planner', action: 'card.cancel', targetState: card.status }).allowed) {
      throw new PlannerToolError(
        'invalid_card_status',
        `Card '${cardId}' in status '${card.status}' cannot be cancelled.`,
      );
    }
    if (subtreeContainsActiveLeaf(this.store, this.runtimeStateProvider?.() ?? null, cardId)) {
      throw new PlannerToolError(
        'card_already_active',
        `Card '${cardId}' cannot be cancelled while its subtree contains the active runtime leaf.`,
      );
    }
    const updated = this.store.setStatus(cardId, 'cancelled');
    if (!card.latest_self_report) {
      return this.store.update(cardId, { latest_self_report: {
        result: 'failed',
        outcome: 'failed',
        reason: 'cancelled',
        at: new Date().toISOString(),
      } });
    }
    return updated;
  }

  deleteCard(cardId: string): void {
    const root = requireCard(this.store, cardId);
    const ids = [cardId, ...this.store.getDescendantIds(cardId)];
    const runtimeState = this.runtimeStateProvider?.() ?? null;
    for (const id of ids) {
      const card = requireCard(this.store, id);
      if (runtimeState?.active_card_run?.card_id === id) {
        throw new PlannerToolError(
          'card_already_active',
          `Card '${cardId}' cannot be deleted while its subtree contains the active runtime leaf.`,
        );
      }
      if (!decide({ role: 'planner', action: 'card.delete', targetState: card.status }).allowed) {
        throw new PlannerToolError(
          'invalid_card_status',
          `Card '${id}' in status '${card.status}' cannot be deleted.`,
        );
      }
    }
    void root;
    this.store.archiveAndDeleteSubtree(ids);
  }

  restartCard(cardId: string): CardRecord {
    const card = requireCard(this.store, cardId);
    if (subtreeContainsActiveLeaf(this.store, this.runtimeStateProvider?.() ?? null, cardId)) {
      throw new PlannerToolError(
        'card_already_active',
        `Card '${cardId}' cannot be restarted while its subtree contains the active runtime leaf.`,
      );
    }
    if (!decide({ role: 'planner', action: 'card.restart', targetState: card.status }).allowed) {
      throw new PlannerToolError(
        'invalid_card_status',
        `Card '${cardId}' in status '${card.status}' cannot be restarted.`,
      );
    }
    this.store.repairTerminalLifecycle(cardId, {
      status: 'backlog',
      lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    });
    const changes: Partial<CardRecord> = {
      duration_ms: null,
      retries: 0,
    };
    if (isGoalLike(card)) {
      changes.latest_self_report = null;
    }
    this.store.update(cardId, changes);
    return this.store.setStatus(cardId, 'active');
  }

  moveCard(
    id: string,
    newParent: string,
    ctx: CardMutationContext & { toolCallId?: string; sessionId?: string },
  ): Record<string, unknown> {
    const r = this.store.moveCard(id, newParent, {
      actor: 'planner',
      surface: 'runtime',
      reason: 'planner move_card',
    });
    recordControlAction(this.projectRoot ?? this.store.projectRoot, {
      actor: 'planner',
      surface: 'runtime',
      action: 'card.move',
      target_kind: 'card',
      target_id: id,
      params_summary: stableStringify({
        id,
        newParent,
        toolCallId: ctx.toolCallId,
        sessionId: ctx.sessionId,
      }),
      outcome: r.ok ? 'ok' : 'error',
      outcome_summary: r.ok ? 'mutation applied' : r.message,
      ...(r.ok ? {} : { error: r.message }),
    });
    if (r.ok) return { success: true, data: r.data };
    return {
      success: false,
      data: {
        reason: r.reason,
        message: r.message,
        current_parent: r.currentParent,
        attempted_parent: r.attemptedParent,
      },
    };
  }

  queueNotification(
    recipient: Recipient,
    kind: string,
    body: string,
    ctx: CardMutationContext & { toolCallId?: string; sessionId?: string },
  ): Record<string, unknown> {
    const projectRoot = this.projectRoot ?? this.store.projectRoot;
    queueNotification(projectRoot, recipient, kind, body, { actor: 'planner', surface: 'runtime' });
    const targetId =
      recipient.kind === 'card'
        ? recipient.cardId
        : recipient.kind === 'role'
          ? recipient.role
          : recipient.sessionId;
    recordControlAction(projectRoot, {
      actor: 'planner',
      surface: 'runtime',
      action: 'notification.queue',
      target_kind: 'session',
      target_id: targetId,
      params_summary: stableStringify({
        recipient,
        kind,
        toolCallId: ctx.toolCallId,
        sessionId: ctx.sessionId,
      }),
      outcome: 'ok',
      outcome_summary: kind,
    });
    return { success: true, data: { queued: true, recipient: targetId } };
  }

  reorderChildren(
    parentId: string,
    orderedChildIds: string[],
    ctx: CardMutationContext & { toolCallId?: string; sessionId?: string },
  ): Record<string, unknown> {
    const r = this.store.reorderChildren(parentId, orderedChildIds, {
      actor: 'planner',
      surface: 'runtime',
      reason: 'planner reorder_child',
    });
    recordControlAction(this.projectRoot ?? this.store.projectRoot, {
      actor: 'planner',
      surface: 'runtime',
      action: 'card.reorder_child',
      target_kind: 'card',
      target_id: parentId,
      params_summary: stableStringify({
        parentId,
        orderedChildIds,
        toolCallId: ctx.toolCallId,
        sessionId: ctx.sessionId,
      }),
      outcome: r.ok ? 'ok' : 'error',
      outcome_summary: r.ok ? 'mutation applied' : 'reorder_set_mismatch',
      ...(r.ok ? {} : { error: 'reorder_set_mismatch' }),
    });
    if (r.ok) return { success: true, data: { parent_id: parentId, changed: r.changed } };
    return {
      success: false,
      data: {
        reason: 'reorder_set_mismatch',
        missing: r.missing,
        extra: r.extra,
        parent_id: parentId,
      },
    };
  }

  reportGoal(
    toolName: keyof typeof REPORTABLE_OUTCOMES,
    goalId: string,
    input: ReportGoalInput,
    sessionId?: string,
  ): ReportGoalResult {
    const result = this.reportGoalSync(toolName, goalId, input, sessionId);
    if (result instanceof Promise) {
      throw new Error(
        'Asynchronous reviewer is not supported by reportGoal(); use reportGoalAsync().',
      );
    }
    return result;
  }

  async reportGoalAsync(
    toolName: keyof typeof REPORTABLE_OUTCOMES,
    goalId: string,
    input: ReportGoalInput,
    sessionId?: string,
  ): Promise<ReportGoalResult> {
    return await this.reportGoalSync(toolName, goalId, input, sessionId);
  }

  private reportGoalSync(
    toolName: keyof typeof REPORTABLE_OUTCOMES,
    goalId: string,
    input: ReportGoalInput,
    sessionId?: string,
  ): ReportGoalResult | Promise<ReportGoalResult> {
    const goal = requireCard(this.store, goalId);
    if ((goal.type !== 'goal' && goal.type !== 'project') || !input.status_text.trim()) {
      throw new Error(`Tool '${toolName}' requires a goal/project card and non-empty status_text.`);
    }
    const evidenceCardIds = input.evidence_card_ids ?? input.report?.evidence_card_ids ?? [];
    if (toolName === 'report_goal_done') {
      const reasons = collectSubtreeReadinessReasons(this.store, goalId);
      if (reasons.length > 0) {
        this.appendSyntheticNote(
          goalId,
          `subtree_not_ready: ${reasons.map((r) => `${r.card_id} is ${r.status}`).join(', ')}`,
        );
        throw new PlannerToolError(
          'subtree_not_ready',
          `Goal '${goalId}' cannot be reported done while descendants are blocked or changed.`,
          { reasons },
        );
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
      try {
        const maybeReview = this.reviewer(
          goalId,
          assessmentId,
          reviewerSessionId,
          report,
          sessionId,
        );
        if (maybeReview instanceof Promise) {
          return maybeReview
            .then((review) =>
              this.applyReviewerAssessment(
                goal,
                report,
                input.status_text,
                sessionId,
                assessmentId,
                reviewerSessionId,
                review,
              ),
            )
            .catch((err: unknown) => {
              throw this.persistReviewerInvocationBlock(goalId, err);
            });
        }
        return this.applyReviewerAssessment(
          goal,
          report,
          input.status_text,
          sessionId,
          assessmentId,
          reviewerSessionId,
          maybeReview,
        );
      } catch (err) {
        throw this.persistReviewerInvocationBlock(goalId, err);
      }
    }

    const updated = this.acceptReport(
      goal,
      toolName,
      report,
      input.status_text,
      sessionId,
      undefined,
    );
    return { card: updated, accepted: true };
  }

  private persistReviewerInvocationBlock(goalId: string, err: unknown): PlannerToolError {
    if (err instanceof PlannerToolError) return err;
    const message = reviewerInvocationFailedMessage(goalId);
    requireCard(this.store, goalId);
    this.store.repairTerminalLifecycle(goalId, {
      ...lifecycleCardPatch({
        status: 'blocked',
        result: {
          kind: 'planner_blocked',
          blocked_reason: message,
          resume_reason: 'reviewer_unavailable',
          created_cards: [],
          updated_cards: [],
        },
        error: message,
        completed_at: null,
      }),
      status_text: message,
      status_text_updated_at: new Date().toISOString(),
    });
    return new PlannerToolError('reviewer_invocation_failed', message);
  }

  private applyReviewerAssessment(
    goal: CardRecord,
    report: GoalSelfReport,
    statusText: string,
    sessionId: string | undefined,
    assessmentId: string,
    reviewerSessionId: string,
    rawReview: ReviewerResult,
  ): ReportGoalResult {
    const review = rawReview;
    const assessment: ReviewAssessment = {
      ...review,
      assessment_id: assessmentId,
      at: new Date().toISOString(),
      reviewer_session_id: reviewerSessionId,
      goal_card_id: goal.id,
    };
    if (assessment.result === 'pass') {
      const updated = this.acceptReport(
        requireCard(this.store, goal.id),
        'report_goal_done',
        report,
        statusText,
        sessionId,
        assessment,
      );
      return { card: updated, accepted: true, assessment };
    }

    const current = requireCard(this.store, goal.id);
    const attempts = current.retries + 1;
    this.store.update(goal.id, { retries: attempts });
    if (attempts > this.maxReviewRetries) {
      this.writePendingSubtreeCorrectionNotes(goal.id, assessment.issues);
      const changed = this.store.setStatus(goal.id, 'changed');
      return { card: changed, accepted: true, assessment };
    }
    return { card: requireCard(this.store, goal.id), accepted: true, assessment };
  }

  private acceptReport(
    goal: CardRecord,
    toolName: keyof typeof REPORTABLE_OUTCOMES,
    report: GoalSelfReport,
    statusText: string,
    sessionId: string | undefined,
    assessment: ReviewAssessment | undefined,
  ): CardRecord {
    const completedAt = new Date().toISOString();
    const status = REPORTABLE_OUTCOMES[toolName];
    const lifecycle = reportLifecycle(status, report, statusText, completedAt);
    void assessment;
    return this.store.repairTerminalLifecycle(goal.id, {
      ...lifecycleCardPatch(lifecycle),
      retries: 0,
      status_text: statusText,
      status_text_updated_at: completedAt,
      status_text_author_session_id: sessionId ?? null,
      latest_self_report: report as Record<string, unknown>,
    });
  }

  private appendSyntheticNote(_cardId: string, _content: string): void {
    return;
  }

  private writePendingSubtreeCorrectionNotes(originId: string, issues: ReviewerIssue[]): void {
    const body = `pending_subtree_correction from ${originId}: ${issues.map((issue) => issue.summary).join('; ')}`;
    const targets = [originId, ...this.store.getAncestors(originId)];
    for (const target of targets) this.appendSyntheticNote(target, body);
  }
}
