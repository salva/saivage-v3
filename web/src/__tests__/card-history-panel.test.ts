import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CardHistoryListResponse } from '../api/contracts';
import CardHistoryPanel from '../components/cards/CardHistoryPanel.vue';
import { useCardStore } from '../stores/cards';
import { cardView, historyEntry, historyHeader, rawCard } from './card-view-fixtures';
vi.mock('../api/client', () => ({ listCards: vi.fn(), getCard: vi.fn(), listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(), ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } } }));
import { listCardHistory, getCardHistoryEntry, getCardDiff, ApiError } from '../api/client';
const CARD = 'card-a';
const header = historyHeader({ kind: 'update', card_id: CARD, version_seq: 2, change_reason: 'planner edit_card', changed_fields: ['title'], change_summary: 'title updated' });
const snapshot = rawCard(CARD, { title: 'before', version_seq: 2 });
describe('CardHistoryPanel', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => { vi.clearAllMocks(); pinia = createPinia(); setActivePinia(pinia); useCardStore().selectedDetail = { cardId: CARD, card: cardView(CARD, { title: 'after', version_seq: 3 }) }; });
  function success(): void { vi.mocked(listCardHistory).mockResolvedValue({ history: [header], total: 1 }); vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: historyEntry({ ...header, snapshot }) }); vi.mocked(getCardDiff).mockResolvedValue({ card_id: CARD, from: 2, to: 3, diff: [{ field: 'title', before: 'before', after: 'after' }] }); }
  it('renders complete history, entry, and diff', async () => { success(); const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises(); expect(wrapper.text()).toContain('title updated'); expect(wrapper.text()).toContain('before'); expect(wrapper.text()).toContain('after'); });
  it('renders loading then empty state', async () => { let resolveHistory: (value: CardHistoryListResponse) => void = () => {}; vi.mocked(listCardHistory).mockReturnValue(new Promise((resolve) => { resolveHistory = resolve; })); const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await Promise.resolve(); expect(wrapper.text()).toContain('Loading card history…'); resolveHistory({ history: [], total: 0 }); await flushPromises(); expect(wrapper.text()).toContain('No tracked card history'); });
  it('renders unauthorized and detail failures', async () => { vi.mocked(listCardHistory).mockRejectedValue(new ApiError(401, 'Unauthorized', {})); const unauthorized = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises(); expect(unauthorized.text()).toContain('Unauthorized'); unauthorized.unmount(); success(); vi.mocked(getCardHistoryEntry).mockRejectedValue(new ApiError(500, 'History detail failed', {})); const failed = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises(); expect(failed.text()).toContain('History detail failed'); });
  it('redacts arbitrary secret-bearing diff values while snapshot remains canonical', async () => { success(); vi.mocked(getCardDiff).mockResolvedValue({ card_id: CARD, from: 2, to: 3, diff: [{ field: 'config_blob', before: 'Bearer very-secret-token', after: 'sk-updated-secret' }, { field: 'safe_field', before: 'before', after: 'after' }] }); const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises(); expect(wrapper.text()).toContain('[redacted]'); expect(wrapper.text()).not.toContain('very-secret-token'); expect(wrapper.text()).not.toContain('sk-updated-secret'); });
});
