import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { CardHistoryListResponse } from '../api/contracts';
import CardHistoryPanel from '../components/cards/CardHistoryPanel.vue';
import { useCardStore } from '../stores/cards';
import { cardView, rawCard } from './card-view-fixtures';
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), getCard: vi.fn(), listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn() }));
import { listCardHistory, getCardHistoryEntry, getCardDiff, OperatorApiError } from '../api/client';
const CARD = 'card-a';
const snapshot = rawCard(CARD, { title: 'before', version_seq: 2 });
const change = { entry_id: '11111111-1111-4111-8111-111111111111', kind: 'update' as const, card_id: CARD, resulting_version: 2, changed_at: '2026-01-01T00:00:01.000Z', changed_by_actor: 'planner' as const, changed_by_surface: 'runtime' as const, changed_fields: ['title'], change_summary: 'title updated', change_reason: 'planner edit_card', terminal_summary: null };
const header = { entry_id: change.entry_id, version: 2, published_at: change.changed_at, artifact_kind: 'card-version' as const, change };
describe('CardHistoryPanel', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => { vi.clearAllMocks(); pinia = createPinia(); setActivePinia(pinia); useCardStore().selectedDetail = { cardId: CARD, card: cardView(CARD, { title: 'after', version_seq: 3 }) }; });
  function success(): void { vi.mocked(listCardHistory).mockResolvedValue({ card_id: CARD, versions: [header], total: 1 }); vi.mocked(getCardHistoryEntry).mockResolvedValue({ card_id: CARD, version: 2, entry_id: change.entry_id, published_at: change.changed_at, artifact: { kind: 'card-version', card: snapshot, change } }); vi.mocked(getCardDiff).mockResolvedValue({ card_id: CARD, from: 2, to: 3, diff: [{ field: 'title', before: 'before', after: 'after' }] }); }
  it('renders complete history, entry, and diff', async () => { success(); const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises(); expect(wrapper.text()).toContain('title updated'); expect(wrapper.text()).toContain('before'); expect(wrapper.text()).toContain('after'); });
  it('renders loading then empty state', async () => { let resolveHistory: (value: CardHistoryListResponse) => void = () => {}; vi.mocked(listCardHistory).mockReturnValue(new Promise((resolve) => { resolveHistory = resolve; })); const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await Promise.resolve(); expect(wrapper.text()).toContain('Loading card history…'); resolveHistory({ card_id: CARD, versions: [], total: 0 }); await flushPromises(); expect(wrapper.text()).toContain('No tracked card history'); });
  it('renders unauthorized and detail failures', async () => { vi.mocked(listCardHistory).mockRejectedValue(new OperatorApiError('cards.history.list', 401, { error: 'Unauthorized', statusCode: 401 })); const unauthorized = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises(); expect(unauthorized.text()).toContain('Unauthorized'); unauthorized.unmount(); success(); vi.mocked(getCardHistoryEntry).mockRejectedValue(new Error('History detail failed')); const failed = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises(); expect(failed.text()).toContain('History detail failed'); });
  it('redacts arbitrary secret-bearing diff values while snapshot remains canonical', async () => { success(); vi.mocked(getCardDiff).mockResolvedValue({ card_id: CARD, from: 2, to: 3, diff: [{ field: 'config_blob', before: 'Bearer very-secret-token', after: 'sk-updated-secret' }, { field: 'safe_field', before: 'before', after: 'after' }] }); const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises(); expect(wrapper.text()).toContain('[redacted]'); expect(wrapper.text()).not.toContain('very-secret-token'); expect(wrapper.text()).not.toContain('sk-updated-secret'); });
});
