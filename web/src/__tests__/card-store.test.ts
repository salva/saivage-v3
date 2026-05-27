import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { CardRecord, CardListResponse, CardDetailResponse, CardEvidence, CardLifecycleSummary, CardReviewSummary, DispatchSummary, CardPlanningSummary } from '../api/types';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.name='ApiError'; this.status=status; this.body=body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));

import { getCard, ApiError } from '../api/client';
const wsTypeHandlers = new Map<string, Set<(e: any) => void>>();
vi.mock('../stores/ws', () => ({ useWsStore: vi.fn(() => ({ onType: (type: string, handler: (e: any) => void) => { let set = wsTypeHandlers.get(type); if (!set) { set = new Set(); wsTypeHandlers.set(type, set); } set.add(handler); return () => set?.delete(handler); } })) }));
import { useCardStore } from '../stores/cards';

function setupStore() { setActivePinia(createPinia()); wsTypeHandlers.clear(); vi.clearAllMocks(); return useCardStore(); }
function makeCard(overrides: Partial<CardRecord> = {}): CardRecord { const id = overrides.id || 'c1'; return { id, type: 'code', parent: null, depth: 0, position: 0, title: `Card ${id}`, description: 'test', status: 'active', tags: [], priority: 5, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, ...overrides }; }
function mlr(cards: CardRecord[], total?: number): CardListResponse { return { cards, total: total ?? cards.length }; }
function mdr(card: CardRecord, children: CardRecord[] = [], ancestorIds: string[] = [], evidence?: CardEvidence, lifecycle?: CardLifecycleSummary, review?: CardReviewSummary, dispatches?: DispatchSummary, planning: CardPlanningSummary | null = null): CardDetailResponse { return { card, children, ancestorIds, evidence, lifecycle: lifecycle || { status: card.status, terminal: false, phase: 'ready', explanation: 'test', completionState: 'in-progress', error: null, startedAt: null, completedAt: null, durationMs: null, retries: 0, childCounts: { drafting: 0, backlog: 0, active: 0, running: 0, blocked: 0, changed: 0, done: 0, failed: 0, cancelled: 0, needs_verification: 0 }, hasActiveChildren: false, hasBlockingChildren: false, dependencyIds: [], blockedByDependencyIds: [] }, review: review || { status: 'not-run', review: null, evidenceStatus: 'none', summary: 'No reviewer assessment is recorded for this card.' }, planning, dispatches: dispatches || { outgoing: [], incoming: [] } }; }

const A = makeCard({ id: 'card-a', title: 'Alpha' });

describe('useCardStore evidence support', () => {
  beforeEach(() => { vi.clearAllMocks(); wsTypeHandlers.clear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('stores evidence and typed detail fields from fetchCardDetail', async () => {
    const s = setupStore();
    const evidence: CardEvidence = {
      generatedFiles: [{ path: 'reports/out.txt', source: 'result.generated_files', exists: true, availabilityReason: 'ok' }],
      verificationCommands: [{ command: 'npm test', process_id: 'p1', status: 'completed', exit_code: 0, timed_out: false }],
      artifactPaths: ['reports/out.txt'],
      toolErrors: [],
      summary: { state: 'present', summary: 'Evidence was recorded for this card.', hasRecordedEvidence: true, hasDurableEvidence: true, missingCount: 0, blockedCount: 0, redactedCount: 0, fileCount: 1, verificationCount: 1, toolErrorCount: 0, parseRecovered: false },
    };
    const review: CardReviewSummary = { status: 'passed', review: { id: 'rev-1', goal_card_id: 'card-a', reviewer_session_id: 'sess-1', result: 'pass', summary: 'ok', achieved: ['done'], missing: [], evidence_card_ids: ['card-a'], created_at: '2025-01-01T00:00:00Z' }, evidenceStatus: 'recorded', summary: 'ok' };
    const planning: CardPlanningSummary = { status: 'continue', summary: null, blockedReason: null, createdCardIds: [], updatedCardIds: [], reviewSummary: 'misleading review summary', plannerDeclaredDone: true, hasUnfinishedChildWork: true };
    vi.mocked(getCard).mockResolvedValue(mdr(A, [], [], evidence, undefined, review, undefined, planning));
    await s.fetchCardDetail('card-a');
    expect(s.currentEvidence).toEqual(evidence);
    expect(s.currentReview?.status).toBe('passed');
    expect(s.currentLifecycle?.status).toBe('active');
    expect(s.currentPlanning).toEqual(planning);
    expect(s.currentPlanning?.hasUnfinishedChildWork).toBe(true);
    expect(s.currentPlanning?.plannerDeclaredDone).toBe(true);
    expect(s.currentDetailFreshness.isStale).toBe(false);
  });

  it('records structured unauthorized detail error', async () => {
    const s = setupStore();
    vi.mocked(getCard).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    await expect(s.fetchCardDetail('card-a')).rejects.toBeTruthy();
    expect(s.currentDetailError).toEqual({ kind: 'unauthorized', status: 401, message: 'Unauthorized' });
  });

  it('marks current detail stale on websocket card-updated events', async () => {
    const s = setupStore();
    s.currentCard = A;
    s.setupWsListener();
    const handler = Array.from(wsTypeHandlers.get('activity') || [])[0];
    handler({ type: 'activity', content: { event: 'card-updated', card: { ...A, title: 'Changed' } } });
    expect(s.currentCard?.title).toBe('Changed');
    expect(s.currentDetailFreshness.isStale).toBe(true);
    expect(s.currentDetailFreshness.staleReason).toBe('ws-card-updated');
  });

  it('reports per-card stale notifications through isStale', () => {
    const s = setupStore();
    s.setCardStaleNotification('card-a', true);
    s.setCardStaleNotification('card-b', false);
    expect(s.isStale('card-a')).toBe(true);
    expect(s.isStale('card-b')).toBe(false);
    expect(s.isStale('card-unknown')).toBe(false);
  });

  it('returns children sorted by position with null-last id tiebreakers', () => {
    const s = setupStore();
    s.cards = [
      makeCard({ id: 'c-e', parent: 'goal-a', position: 3 }),
      makeCard({ id: 'c-b', parent: 'goal-a', position: 1 }),
      makeCard({ id: 'c-d', parent: 'goal-a', position: undefined }),
      makeCard({ id: 'c-a', parent: 'goal-a', position: 1 }),
      makeCard({ id: 'c-c', parent: 'goal-a', position: 2 }),
      makeCard({ id: 'other', parent: 'goal-b', position: 0 }),
    ];
    expect(s.childrenOf('goal-a').map((card) => card.id)).toEqual(['c-a', 'c-b', 'c-c', 'c-e', 'c-d']);
    expect(s.childrenOf('goal-unknown')).toEqual([]);
  });
});
