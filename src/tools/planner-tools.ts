import type {
  CardRecord,
  CardStatus,
  RuntimeState,
} from '../schemas/index.js';
import type { CardLifecycleState } from '../schemas/index.js';
import type { Recipient } from '../notifications/index.js';
import { decide } from '../permissions/index.js';
import { CardStore } from '../cards/store-api.js';
import { recordControlAction, stableStringify } from '../persistence/index.js';
import { queueNotification } from '../notifications/index.js';
import type { CardMutationContext } from '../cards/store-api.js';
import { isTerminalState } from '../cards/lifecycle.js';
import { lifecycleCardPatch } from '../runtime/terminal-commit/lifecycle-patch.js';

export type PlannerToolErrorKind =
  | 'subtree_not_ready'
  | 'invalid_evidence'
  | 'terminal_card_requires_restart'
  | 'card_already_running'
  | 'invalid_card_status';

export type SubtreeReadinessReason = {
  kind: 'descendant_not_terminal';
  card_id: string;
  status: CardStatus;
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
}

export interface PlannerToolsServiceOptions {
  runtimeStateProvider?: () => RuntimeState | null;
  projectRoot?: string;
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

function reportLifecycle(status: Extract<CardStatus, 'done' | 'failed' | 'blocked'>, report: GoalSelfReport, statusText: string, completedAt: string): CardLifecycleState {
  if (status === 'done') {
    return {
      status: 'running',
      result: { kind: 'planner_done', summary: report.summary?.trim() ? report.summary : statusText },
      error: null,
      completed_at: null,
    };
  }
  if (status === 'blocked') {
    return {
      status,
      result: { kind: 'planner_blocked', blocked_reason: statusText, resume_reason: 'planner_report_blocked', blocker_cause: 'generic' },
      error: statusText,
      completed_at: null,
    };
  }
  return {
    status,
    result: {
      kind: 'planner_failure',
      error: statusText,
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
    if (!isTerminalState(descendant.status)) {
      reasons.push({
        kind: 'descendant_not_terminal',
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

  constructor(
    private readonly store: CardStore,
    runtimeStateProviderOrOptions?: (() => RuntimeState | null) | PlannerToolsServiceOptions,
  ) {
    if (typeof runtimeStateProviderOrOptions === 'function') {
      this.runtimeStateProvider = runtimeStateProviderOrOptions;
    } else {
      this.runtimeStateProvider = runtimeStateProviderOrOptions?.runtimeStateProvider;
      this.projectRoot = runtimeStateProviderOrOptions?.projectRoot;
    }
  }

  cancelCard(cardId: string): CardRecord {
    const card = requireCard(this.store, cardId);
    if (subtreeContainsActiveLeaf(this.store, this.runtimeStateProvider?.() ?? null, cardId)) {
      throw new PlannerToolError(
        'card_already_running',
        `Card '${cardId}' cannot be cancelled while its subtree contains the running runtime leaf.`,
      );
    }
    if (!decide({ role: 'planner', action: 'card.cancel', targetState: card.status }).allowed) {
      throw new PlannerToolError(
        'invalid_card_status',
        `Card '${cardId}' in status '${card.status}' cannot be cancelled.`,
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
          'card_already_running',
          `Card '${cardId}' cannot be deleted while its subtree contains the running runtime leaf.`,
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
        'card_already_running',
        `Card '${cardId}' cannot be restarted while its subtree contains the running runtime leaf.`,
      );
    }
    if (!decide({ role: 'planner', action: 'card.restart', targetState: card.status }).allowed) {
      throw new PlannerToolError(
        'invalid_card_status',
        `Card '${cardId}' in status '${card.status}' cannot be restarted.`,
      );
    }
    // Planner restart is an explicit lifecycle repair from terminal/blocked/changed states back to schedulable work.
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
    return this.store.read(cardId)!;
  }

  queueNotification(
    recipient: Recipient,
    kind: string,
    body: string,
    ctx: CardMutationContext & { toolCallId?: string; sessionId?: string },
  ): Record<string, unknown> {
    const projectRoot = this.projectRoot ?? this.store.projectRoot;
    queueNotification(projectRoot, recipient, kind, body, { actor: 'planner', surface: 'runtime' }, this.store);
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
    const goal = requireCard(this.store, goalId);
    if ((goal.type !== 'goal' && goal.type !== 'project') || !input.status_text.trim()) {
      throw new Error(`Tool '${toolName}' requires a goal/project card and non-empty status_text.`);
    }
    const evidenceCardIds = input.evidence_card_ids ?? input.report?.evidence_card_ids ?? [];
    if (toolName === 'report_goal_done') {
      const reasons = collectSubtreeReadinessReasons(this.store, goalId);
      if (reasons.length > 0) {
        throw new PlannerToolError(
          'subtree_not_ready',
          `Goal '${goalId}' cannot be reported done while descendants are non-terminal.`,
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

    const updated = this.acceptReport(
      goal,
      toolName,
      report,
      input.status_text,
      sessionId,
    );
    return { card: updated, accepted: true };
  }

  private acceptReport(
    goal: CardRecord,
    toolName: keyof typeof REPORTABLE_OUTCOMES,
    report: GoalSelfReport,
    statusText: string,
    sessionId: string | undefined,
  ): CardRecord {
    const completedAt = new Date().toISOString();
    const status = REPORTABLE_OUTCOMES[toolName];
    const lifecycle = reportLifecycle(status, report, statusText, completedAt);
    // Planner terminal reports commit done/failed/blocked lifecycle state with result evidence.
    return this.store.repairTerminalLifecycle(goal.id, {
      ...lifecycleCardPatch(lifecycle),
      retries: 0,
      status_text: statusText,
      status_text_updated_at: completedAt,
      status_text_author_session_id: sessionId ?? null,
      latest_self_report: report as Record<string, unknown>,
    });
  }
}
