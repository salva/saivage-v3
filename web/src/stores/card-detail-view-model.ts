import type { CardRecord, CardRefView, CardStatus, ReviewAssessment } from '../api/types';

export interface CardLifecycleSummary {
  status: CardStatus;
  terminal: boolean;
  phase: 'planned' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  explanation: string;
  completionState: 'not-started' | 'in-progress' | 'blocked' | 'failed' | 'cancelled' | 'marked-done';
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  retries: number;
  childCounts: Record<CardStatus, number>;
  hasActiveChildren: boolean;
  hasBlockingChildren: boolean;
  dependencyIds: string[];
  blockedByDependencyIds: string[];
}

export interface CardReviewSummary {
  status: 'not-run' | 'passed' | 'failed' | 'incomplete';
  review: ReviewAssessment | null;
  evidenceStatus: 'none' | 'partial' | 'recorded';
  summary: string;
}

export interface CardPlanningSummary {
  status: string | null;
  summary: string | null;
  blockedReason: string | null;
  createdCardIds: string[];
  updatedCardIds: string[];
  reviewSummary: string | null;
  hasUnfinishedChildWork: boolean;
  plannerDeclaredDone: boolean;
}

export interface DispatchSummaryItem {
  dispatchId: string;
  direction: 'outgoing' | 'incoming';
  parentCardId: string;
  targetCardId: string;
  targetKind: 'goal' | 'terminal_card';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'timed_out';
  outcome: 'done' | 'failed' | 'blocked' | 'cancelled' | 'timed_out' | null;
  summary: string | null;
  error: string | null;
  evidenceCardIds: string[];
  completedAt: string | null;
}

export interface DispatchSummary {
  outgoing: DispatchSummaryItem[];
  incoming: DispatchSummaryItem[];
}

export interface CardDetailViewModel {
  card: CardRecord;
  children: CardRecord[];
  ancestorIds: string[];
  ancestorRefs: CardRefView[];
  lifecycle?: CardLifecycleSummary | null;
  review?: CardReviewSummary | null;
  planning?: CardPlanningSummary | null;
  dispatches?: DispatchSummary | null;
}

const terminalStatuses = new Set<CardStatus>(['done', 'failed', 'cancelled']);

function lifecyclePhase(status: CardStatus): CardLifecycleSummary['phase'] {
  switch (status) {
    case 'backlog': return 'planned';
    case 'running': return 'running';
    case 'blocked': return 'blocked';
    case 'done': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'ready';
  }
}

function completionState(status: CardStatus): CardLifecycleSummary['completionState'] {
  switch (status) {
    case 'backlog': return 'not-started';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'done': return 'marked-done';
    default: return 'in-progress';
  }
}

export function deriveCardLifecycleSummary(card: CardRecord, children: CardRecord[] = []): CardLifecycleSummary {
  const childCounts = {
    backlog: 0,
    running: 0,
    blocked: 0,
    changed: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    needs_verification: 0,
  } satisfies Record<CardStatus, number>;
  for (const child of children) childCounts[child.status] += 1;
  return {
    status: card.status,
    terminal: terminalStatuses.has(card.status),
    phase: lifecyclePhase(card.status),
    explanation: '',
    completionState: completionState(card.status),
    error: card.lifecycle?.error ?? null,
    startedAt: card.started_at ?? null,
    completedAt: card.lifecycle?.completed_at ?? null,
    durationMs: null,
    retries: card.retries,
    childCounts,
    hasActiveChildren: children.some((child) => child.status === 'running'),
    hasBlockingChildren: children.some((child) => child.status === 'blocked' || child.status === 'failed'),
    dependencyIds: card.depends_on,
    blockedByDependencyIds: [],
  };
}

export function toCardDetailViewModel(response: { card: CardRecord; children: CardRecord[]; ancestorIds: string[]; ancestorRefs?: CardRefView[] }): CardDetailViewModel {
  return {
    card: response.card,
    children: response.children,
    ancestorIds: response.ancestorIds,
    ancestorRefs: response.ancestorRefs ?? response.ancestorIds.map((id) => ({ id, display_path: null, title: null })),
    lifecycle: deriveCardLifecycleSummary(response.card, response.children),
    review: null,
    planning: null,
    dispatches: null,
  };
}
