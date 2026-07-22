import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CardHistoryPanel from '../components/cards/CardHistoryPanel.vue';
import { useCardStore } from '../stores/cards';
import { cardView, historyEntry, historyHeader, rawCard } from './card-view-fixtures';
vi.mock('../api/client', () => ({ listCards: vi.fn(), getCard: vi.fn(), listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(), ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } } }));
import { listCardHistory, getCardHistoryEntry, getCardDiff } from '../api/client';
const CARD = 'card-a';
describe('CardHistoryPanel order', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => { vi.clearAllMocks(); pinia = createPinia(); setActivePinia(pinia); useCardStore().selectedDetail = { cardId: CARD, card: cardView(CARD, { version_seq: 3 }), records: [] }; });
  it('renders snapshot child IDs in backend order without resorting', async () => {
    const children = ['card-a-c', 'card-a-a', 'card-a-b'];
    const header = historyHeader({ kind: 'reorder', card_id: CARD, version_seq: 2, change_reason: 'children reordered', changed_fields: ['children'], change_summary: 'children reordered' });
    const snapshot = rawCard(CARD, { children, version_seq: 2 });
    vi.mocked(listCardHistory).mockResolvedValue({ history: [header], total: 1 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: historyEntry({ ...header, snapshot }) });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: CARD, from: 2, to: 3, diff: [{ field: 'children', before: children, after: [] }] });
    const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises();
    const text = wrapper.text(); expect(text.indexOf('card-a-c')).toBeLessThan(text.indexOf('card-a-a')); expect(text.indexOf('card-a-a')).toBeLessThan(text.indexOf('card-a-b'));
  });
});
