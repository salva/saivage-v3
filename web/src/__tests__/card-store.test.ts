import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { CardRecord, CardListResponse, CardDetailResponse, CardCreateResponse, CardUpdateResponse, CardEvidence } from '../api/types';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(), createCard: vi.fn(), updateCard: vi.fn(), deleteCard: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.name='ApiError'; this.status=status; this.body=body; } },
}));

import { listCards, getCard, createCard, updateCard, deleteCard } from '../api/client';
const wsTypeHandlers = new Map<string, Set<(e: any) => void>>();
vi.mock('../stores/ws', () => ({ useWsStore: vi.fn(() => ({ onType: (type: string, handler: (e: any) => void) => { let set = wsTypeHandlers.get(type); if (!set) { set = new Set(); wsTypeHandlers.set(type, set); } set.add(handler); return () => set?.delete(handler); } })) }));
import { useCardStore } from '../stores/cards';

function setupStore() { setActivePinia(createPinia()); wsTypeHandlers.clear(); vi.clearAllMocks(); return useCardStore(); }
function makeCard(overrides: Partial<CardRecord> = {}): CardRecord { const id = overrides.id || 'c1'; return { id, type: 'code', parent: null, depth: 0, title: `Card ${id}`, description: 'test', status: 'active', tags: [], priority: 5, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, ...overrides }; }
function mlr(cards: CardRecord[], total?: number): CardListResponse { return { cards, total: total ?? cards.length }; }
function mcr(card: CardRecord): CardCreateResponse { return { card }; }
function mur(card: CardRecord): CardUpdateResponse { return { card }; }
function mdr(card: CardRecord, children: CardRecord[] = [], ancestorIds: string[] = [], evidence?: CardEvidence): CardDetailResponse { return { card, children, ancestorIds, evidence }; }

const A = makeCard({ id: 'card-a', title: 'Alpha' });

describe('useCardStore evidence support', () => {
  beforeEach(() => { vi.clearAllMocks(); wsTypeHandlers.clear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('stores evidence from fetchCardDetail', async () => {
    const s = setupStore();
    const evidence: CardEvidence = {
      generatedFiles: [{ path: 'reports/out.txt', source: 'result.generated_files', exists: true }],
      verificationCommands: [{ command: 'npm test', process_id: 'p1', status: 'completed', exit_code: 0, timed_out: false }],
      artifactPaths: ['reports/out.txt'],
      toolErrors: [],
    };
    vi.mocked(getCard).mockResolvedValue(mdr(A, [], [], evidence));
    await s.fetchCardDetail('card-a');
    expect(s.currentEvidence).toEqual(evidence);
  });

  it('clears evidence when deleting current card', async () => {
    const s = setupStore();
    s.currentCard = A;
    s.currentEvidence = { generatedFiles: [], verificationCommands: [], artifactPaths: [], toolErrors: [] };
    vi.mocked(deleteCard).mockResolvedValue(undefined);
    await s.removeCard('card-a');
    expect(s.currentEvidence).toBeNull();
  });
});
