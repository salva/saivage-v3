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

import { listCardHistory, getCardHistoryEntry, getCardDiff, ApiError } from '../api/client';

describe('CardHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    const store = useCardStore();
    store.currentCard = { id: 'card-1', version_seq: 3 } as any;
  });

  it('renders success path with history list, entry details, and diff rows', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [{ card_id: 'card-1', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'rest', change_reason: 'update', changed_fields: ['acceptance'], change_summary: 'acceptance updated' }], total: 1 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: { card_id: 'card-1', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'rest', change_reason: 'update', changed_fields: ['acceptance'], change_summary: 'acceptance updated', snapshot: { id: 'card-1', acceptance: 'before' } as any } });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: 'card-1', from: 2, to: 3, diff: [{ field: 'acceptance', before: 'before', after: 'after' }] });

    const wrapper = mount(CardHistoryPanel, { props: { cardId: 'card-1' }, global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('acceptance updated');
    expect(wrapper.text()).toContain('Diff vs current card');
    expect(wrapper.text()).toContain('before');
    expect(wrapper.text()).toContain('after');
  });

  it('renders empty state when no history exists', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [], total: 0 });
    const wrapper = mount(CardHistoryPanel, { props: { cardId: 'card-1' }, global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain('No tracked card history exists yet for this card.');
  });

  it('renders unauthorized state', async () => {
    vi.mocked(listCardHistory).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    const wrapper = mount(CardHistoryPanel, { props: { cardId: 'card-1' }, global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Unauthorized');
  });
});