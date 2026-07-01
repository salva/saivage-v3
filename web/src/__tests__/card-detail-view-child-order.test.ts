import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CardRecord } from '../api/types';
import CardDetailView from '../components/cards/CardDetailView.vue';
import { useCardStore } from '../stores/cards';

vi.mock('../api/client', () => ({
  getFileContent: vi.fn(), listCards: vi.fn(), getCard: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
vi.mock('../stores/analystChat', () => ({ useAnalystChat: () => ({ hasDraft: false, seedCardContext: vi.fn(), fetchMessages: vi.fn(async () => undefined), activeSessionId: 'analyst:global' }) }));
vi.mock('../utils/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('../components/cards/CardHistoryPanel.vue', () => ({ default: { template: '<section />', props: ['cardId'] } }));

function card(overrides: Partial<CardRecord>): CardRecord {
  const lifecycle = overrides.lifecycle ?? { status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle'];
  return { id: 'card', type: 'code', parent: null, depth: 0, position: 0, title: 'Card', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], retries: 0, ...overrides, display_path: overrides.display_path ?? null, lifecycle, operator_summary: overrides.operator_summary ?? { lifecycleStatus: lifecycle.status, terminal: false, needsVerification: lifecycle.status === 'needs_verification', blocked: lifecycle.status === 'blocked', hasError: Boolean(lifecycle.error), error: lifecycle.error ?? null, completedAt: lifecycle.completed_at ?? null, stale: lifecycle.status === 'changed', actionCount: 0 } };
}

describe('CardDetailView child order', () => {
  it('renders currentChildren in backend order without sorting', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useCardStore();
    store.currentCard = card({ id: 'parent', title: 'Parent' });
    store.currentChildren = [
      card({ id: 'low', parent: 'parent', title: 'Zulu low', priority: 1 }),
      card({ id: 'high', parent: 'parent', title: 'Alpha high', priority: 99 }),
      card({ id: 'mid', parent: 'parent', title: 'Middle', priority: 50 }),
    ];
    store.currentAncestorIds = [];
    store.currentLifecycle = { status: 'backlog', terminal: false, phase: 'ready', explanation: 'ready', completionState: 'not-started', error: null, startedAt: null, completedAt: null, durationMs: null, retries: 0, childCounts: { backlog: 3, running: 0, blocked: 0, changed: 0, done: 0, failed: 0, cancelled: 0, needs_verification: 0 }, hasActiveChildren: false, hasBlockingChildren: false, dependencyIds: [], blockedByDependencyIds: [] };
    store.currentPlanning = null;
    store.currentDispatches = { outgoing: [], incoming: [] };
    store.fetchCardDetail = vi.fn(async () => undefined) as any;

    const wrapper = mount(CardDetailView, { props: { cardId: 'parent' }, global: { plugins: [pinia] } });
    await flushPromises();

    expect(wrapper.findAll('.child-row .child-card-title').map((node) => node.text())).toEqual(['Zulu low', 'Alpha high', 'Middle']);
  });
});
