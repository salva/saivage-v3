import type { CardRecord, CardStatus } from '../schemas/types.js';
import { CardStore } from './card-store.js';

export type PlannerToolErrorKind =
  | 'subtree_not_ready'
  | 'invalid_evidence'
  | 'terminal_card_requires_restart'
  | 'card_already_active';

export class PlannerToolError extends Error {
  constructor(
    public readonly kind: PlannerToolErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'PlannerToolError';
  }
}

export interface GoalSelfReport {
  summary?: string;
  outcome?: 'done' | 'failed' | 'blocked';
  evidence_card_ids?: string[];
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

const TERMINAL_STATUSES = new Set<CardStatus>(['done', 'failed', 'cancelled']);
const CANCELLABLE_STATUSES = new Set<CardStatus>(['backlog', 'active', 'blocked']);
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

function hasActiveLeafInSubtree(store: CardStore, cardId: string): boolean {
  for (const descendantId of store.getDescendantIds(cardId)) {
    const descendant = store.read(descendantId);
    if (!descendant) continue;
    if (descendant.status === 'active') return true;
  }
  return false;
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
  }
}

function assertSubtreeReadyForDone(store: CardStore, goalId: string): void {
  for (const descendantId of store.getDescendantIds(goalId)) {
    const descendant = requireCard(store, descendantId);
    if (descendant.status === 'blocked' || descendant.status === 'failed') {
      throw new PlannerToolError('subtree_not_ready', `Goal '${goalId}' cannot be reported done while descendant '${descendantId}' is '${descendant.status}'.`);
    }
  }
}

export class PlannerToolsService {
  constructor(private readonly store: CardStore) {}

  activateCard(cardId: string): CardRecord {
    const card = requireCard(this.store, cardId);
    if (card.status === 'active') {
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
    if (hasActiveLeafInSubtree(this.store, cardId)) {
      throw new PlannerToolError('card_already_active', `Card '${cardId}' cannot be cancelled while its subtree contains an active descendant.`);
    }
    return this.store.update(cardId, { status: 'cancelled' });
  }

  deleteCard(cardId: string): void {
    const card = requireCard(this.store, cardId);
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
    if (!TERMINAL_STATUSES.has(card.status)) {
      throw new Error(`Card '${cardId}' is not terminal and cannot be restarted.`);
    }
    this.store.update(cardId, { status: 'backlog' });
    const changes: Partial<CardRecord> = {
      result: null,
      error: null,
      completed_at: null,
      duration_ms: null,
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
    const goal = requireCard(this.store, goalId);
    if ((goal.type !== 'goal' && goal.type !== 'project') || !input.status_text.trim()) {
      throw new Error(`Tool '${toolName}' requires a goal/project card and non-empty status_text.`);
    }
    const evidenceCardIds = input.evidence_card_ids ?? input.report?.evidence_card_ids ?? [];
    if (toolName === 'report_goal_done') {
      assertSubtreeReadyForDone(this.store, goalId);
      assertEvidenceCardsReady(this.store, goalId, evidenceCardIds);
    } else if (evidenceCardIds.length > 0) {
      assertEvidenceCardsReady(this.store, goalId, evidenceCardIds);
    }

    const report: GoalSelfReport = {
      ...(input.report ?? {}),
      summary: input.report?.summary ?? input.summary,
      outcome: input.report?.outcome ?? REPORTABLE_OUTCOMES[toolName],
      evidence_card_ids: evidenceCardIds,
      status_text: input.status_text,
    };

    const updated = this.store.update(goalId, {
      status: REPORTABLE_OUTCOMES[toolName],
      status_text: input.status_text,
      status_text_updated_at: new Date().toISOString(),
      status_text_author_session_id: sessionId ?? null,
      latest_self_report: report as Record<string, unknown>,
      result: {
        ...cloneResult(goal),
        latest_self_report: report,
      },
    });
    return { card: updated, accepted: true };
  }
}
