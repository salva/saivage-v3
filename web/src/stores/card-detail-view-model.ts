import type { CardRecord, CardStatus, ReviewAssessment } from '../api/types';

export type SafeFileSensitivity = 'normal' | 'sensitive-blocked' | 'sensitive-redacted';

export interface GeneratedFileRef {
  path: string;
  source: 'artifact' | 'attachment' | 'result.generated_files' | 'result.artifact_paths';
  artifactId?: string;
  attachmentId?: string;
  artifactType?: CardRecord['artifacts'][number]['type'];
  description?: string;
  retain?: boolean;
  exists?: boolean;
  size?: number;
  modifiedAt?: string;
  previewable?: boolean;
  downloadable?: boolean;
  blocked?: boolean;
  redactedOnly?: boolean;
  sensitivity?: SafeFileSensitivity;
  availabilityReason?: string;
}

export interface VerificationCommandRef {
  command: string;
  process_id: string | null;
  status: string | null;
  exit_code: number | null;
  timed_out: boolean | null;
}

export type CardEvidenceState = 'none-recorded' | 'partial' | 'present' | 'missing-files' | 'blocked' | 'redacted' | 'incomplete';

export interface CardEvidenceSummary {
  state: CardEvidenceState;
  summary: string;
  hasRecordedEvidence: boolean;
  hasDurableEvidence: boolean;
  missingCount: number;
  blockedCount: number;
  redactedCount: number;
  fileCount: number;
  verificationCount: number;
  toolErrorCount: number;
  parseRecovered: boolean;
}

export interface CardEvidence {
  generatedFiles: GeneratedFileRef[];
  verificationCommands: VerificationCommandRef[];
  artifactPaths: string[];
  toolErrors: string[];
  parseFailure?: Record<string, unknown>;
  summary: CardEvidenceSummary;
}

export interface CardLifecycleSummary {
  status: CardStatus;
  terminal: boolean;
  phase: 'drafting' | 'planned' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
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
  evidence?: CardEvidence | null;
  lifecycle?: CardLifecycleSummary | null;
  review?: CardReviewSummary | null;
  planning?: CardPlanningSummary | null;
  dispatches?: DispatchSummary | null;
}

const terminalStatuses = new Set<CardStatus>(['done', 'failed', 'cancelled']);

function lifecyclePhase(status: CardStatus): CardLifecycleSummary['phase'] {
  switch (status) {
    case 'drafting': return 'drafting';
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
    case 'drafting':
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
    drafting: 0,
    backlog: 0,
    active: 0,
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
    hasActiveChildren: children.some((child) => child.status === 'active' || child.status === 'running'),
    hasBlockingChildren: children.some((child) => child.status === 'blocked' || child.status === 'failed'),
    dependencyIds: card.depends_on,
    blockedByDependencyIds: [],
  };
}

export function toCardDetailViewModel(response: { card: CardRecord; children: CardRecord[]; ancestorIds: string[] }): CardDetailViewModel {
  return {
    card: response.card,
    children: response.children,
    ancestorIds: response.ancestorIds,
    lifecycle: deriveCardLifecycleSummary(response.card, response.children),
    evidence: null,
    review: null,
    planning: null,
    dispatches: null,
  };
}
