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

describe('CardHistoryPanel analyst filter', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    vi.clearAllMocks();
    pinia = createPinia();
    setActivePinia(pinia);
    useCardStore().selectedDetail = { cardId: '11111111-1111-4111-8111-111111111111', card: { id: '11111111-1111-4111-8111-111111111111', version_seq: 3 } as any };
  });

  it('filters down to analyst-authored entries only', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [
      { entry_id: 'entry-2-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: 'update', changed_fields: ['acceptance'], change_summary: 'analyst update' },
      { entry_id: 'entry-1-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 1, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'planner', changed_by_surface: 'runtime', change_reason: 'update', changed_fields: ['title'], change_summary: 'planner update' },
    ], total: 2 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: { entry_id: 'entry-2-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 2, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: 'update', changed_fields: ['acceptance'], change_summary: 'analyst update', snapshot: { id: '11111111-1111-4111-8111-111111111111' } as any } });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: '11111111-1111-4111-8111-111111111111', from: 2, to: 3, diff: [] });

    const wrapper = mount(CardHistoryPanel, { props: { cardId: '11111111-1111-4111-8111-111111111111' }, global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain('planner update');
    await wrapper.find('.filter-chip').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('analyst update');
    expect(wrapper.text()).toContain('analyst (web-chat)');
    expect(wrapper.text()).not.toContain('planner update');
  });
});

describe('CardHistoryPanel analyst filter affordance', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    vi.clearAllMocks();
    pinia = createPinia();
    setActivePinia(pinia);
    useCardStore().selectedDetail = { cardId: '11111111-1111-4111-8111-111111111111', card: { id: '11111111-1111-4111-8111-111111111111', version_seq: 2 } as any };
  });

  it('explains the analyst filter and changes label when active', async () => {
    vi.mocked(listCardHistory).mockResolvedValue({ history: [
      { entry_id: 'entry-1-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 1, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: 'update', changed_fields: ['title'], change_summary: 'analyst update' },
    ], total: 1 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: { entry_id: 'entry-1-uuid', kind: 'update' as const, card_id: '11111111-1111-4111-8111-111111111111', version_seq: 1, changed_at: '2025-01-01T00:00:00Z', changed_by_actor: 'analyst', changed_by_surface: 'web-chat', change_reason: 'update', changed_fields: ['title'], change_summary: 'analyst update', snapshot: { id: '11111111-1111-4111-8111-111111111111' } as any } });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: '11111111-1111-4111-8111-111111111111', from: 1, to: 2, diff: [] });

    const wrapper = mount(CardHistoryPanel, { props: { cardId: '11111111-1111-4111-8111-111111111111' }, global: { plugins: [pinia] } });
    await flushPromises();
    const chip = wrapper.get('.filter-chip');
    expect(chip.attributes('title')).toBe('Filter card history by editor (currently: analyst)');
    expect(chip.text()).toBe('by analyst');
    await chip.trigger('click');
    await flushPromises();
    expect(wrapper.get('.filter-chip').text()).toBe('all history');
    expect(wrapper.get('.filter-chip').attributes('title')).toBe('Showing analyst web-chat history only');
  });
});
