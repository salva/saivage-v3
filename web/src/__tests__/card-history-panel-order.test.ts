import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CardHistoryPanel from '../components/cards/CardHistoryPanel.vue';
import { useCardStore } from '../stores/cards';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(), createCard: vi.fn(), updateCard: vi.fn(), deleteCard: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
vi.mock('../stores/ws', () => ({ useWsStore: () => ({ onType: vi.fn(() => vi.fn()) }) }));
import { listCardHistory, getCardHistoryEntry, getCardDiff } from '../api/client';

describe('CardHistoryPanel order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    useCardStore().currentCard = { id: 'parent', version_seq: 4 } as any;
  });

  it('renders snapshot child arrays in backend order without resorting', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [{ entry_id: 'entry-2', kind: 'mutate' as const, card_id: 'parent', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: 'reorder', changed_fields: ['children'], change_summary: 'children reordered' }], total: 1 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: { entry_id: 'entry-2', kind: 'mutate' as const, card_id: 'parent', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: 'reorder', changed_fields: ['children'], change_summary: 'children reordered', snapshot: { id: 'parent', children: [{ id: 'low', title: 'Zulu low', priority: 1 }, { id: 'high', title: 'Alpha high', priority: 99 }, { id: 'mid', title: 'Middle', priority: 50 }] } as any } });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: 'parent', from: 2, to: 4, diff: [{ field: 'children', before: [{ id: 'low', title: 'Zulu low', priority: 1 }, { id: 'high', title: 'Alpha high', priority: 99 }, { id: 'mid', title: 'Middle', priority: 50 }], after: [] }] });

    const wrapper = mount(CardHistoryPanel, { props: { cardId: 'parent' }, global: { plugins: [createPinia()] } });
    await flushPromises();

    const text = wrapper.text();
    expect(text.indexOf('Zulu low')).toBeLessThan(text.indexOf('Alpha high'));
    expect(text.indexOf('Alpha high')).toBeLessThan(text.indexOf('Middle'));
  });
});
