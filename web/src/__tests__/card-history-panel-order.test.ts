import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CardHistoryPanel from '../components/cards/CardHistoryPanel.vue';
import { useCardStore } from '../stores/cards';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
import { listCardHistory, getCardHistoryEntry, getCardDiff } from '../api/client';

describe('CardHistoryPanel order', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    vi.clearAllMocks();
    pinia = createPinia();
    setActivePinia(pinia);
    useCardStore().selectedDetail = { cardId: '11111111-1111-4111-8111-111111111111', card: { id: '11111111-1111-4111-8111-111111111111', version_seq: 4 } as any };
  });

  it('renders snapshot child arrays in backend order without resorting', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [{ entry_id: 'entry-2', kind: 'mutate' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: 'reorder', changed_fields: ['children'], change_summary: 'children reordered' }], total: 1 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: { entry_id: 'entry-2', kind: 'mutate' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: 'reorder', changed_fields: ['children'], change_summary: 'children reordered', snapshot: { id: '11111111-1111-4111-8111-111111111111', children: [{ id: '22222222-2222-4222-8222-222222222222', title: 'Zulu low', priority: 1 }, { id: '33333333-3333-4333-8333-333333333333', title: 'Alpha high', priority: 99 }, { id: '44444444-4444-4444-8444-444444444444', title: 'Middle', priority: 50 }] } as any } });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: '11111111-1111-4111-8111-111111111111', from: 2, to: 4, diff: [{ field: 'children', before: [{ id: '22222222-2222-4222-8222-222222222222', title: 'Zulu low', priority: 1 }, { id: '33333333-3333-4333-8333-333333333333', title: 'Alpha high', priority: 99 }, { id: '44444444-4444-4444-8444-444444444444', title: 'Middle', priority: 50 }], after: [] }] });

    const wrapper = mount(CardHistoryPanel, { props: { cardId: '11111111-1111-4111-8111-111111111111' }, global: { plugins: [pinia] } });
    await flushPromises();

    const text = wrapper.text();
    expect(text.indexOf('Zulu low')).toBeLessThan(text.indexOf('Alpha high'));
    expect(text.indexOf('Alpha high')).toBeLessThan(text.indexOf('Middle'));
  });
});
