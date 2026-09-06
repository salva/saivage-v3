import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CardHistoryPanel from '../components/cards/CardHistoryPanel.vue';
import { useCardStore } from '../stores/cards';
import { cardView, rawCard } from './card-view-fixtures';
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), getCard: vi.fn(), listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn() }));
import { listCardHistory, getCardHistoryEntry, getCardDiff } from '../api/client';
import { parseOperatorResponse } from '../api/contracts';
const CARD = 'card-a';
describe('CardHistoryPanel order', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => { vi.clearAllMocks(); pinia = createPinia(); setActivePinia(pinia); useCardStore().selectedDetail = { cardId: CARD, card: cardView(CARD, { version_seq: 3 }) }; });
  it('renders snapshot child IDs in backend order without resorting', async () => {
    const children = ['card-a-c', 'card-a-a', 'card-a-b'];
    const change = { entry_id: '11111111-1111-4111-8111-111111111111', kind: 'reorder' as const, card_id: CARD, resulting_version: 2, changed_at: '2026-01-01T00:00:01.000Z', changed_by_actor: 'runtime' as const, changed_by_surface: 'runtime' as const, changed_fields: ['active_child_order'], change_summary: 'children reordered', change_reason: 'children reordered', terminal_summary: null };
    const header = { entry_id: change.entry_id, version: 2, published_at: change.changed_at, artifact_kind: 'card-version' as const, change };
    const snapshot = rawCard(CARD, { child_membership: children, active_child_order: children, version_seq: 2 });
    vi.mocked(listCardHistory).mockResolvedValue({ card_id: CARD, versions: [header], total: 1 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ card_id: CARD, version: 2, entry_id: change.entry_id, published_at: change.changed_at, artifact: { kind: 'card-version', card: snapshot, change } });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: CARD, from: 2, to: 3, diff: [{ field: 'active_child_order', before: children, after: [] }] });
    const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises();
    const text = wrapper.text(); expect(text.indexOf('card-a-c')).toBeLessThan(text.indexOf('card-a-a')); expect(text.indexOf('card-a-a')).toBeLessThan(text.indexOf('card-a-b'));
    expect(text).toContain('child_membership');
    expect(text).toContain('active_child_order');
  });

  it('strictly rejects the removed durable children field at the web response boundary', () => {
    const current = rawCard(CARD);
    const { child_membership: _membership, active_child_order: _order, ...withoutRelationships } = current;
    const artifact = { kind: 'card-version' as const, card: { ...withoutRelationships, children: [] }, change: null };
    expect(() => parseOperatorResponse('cards.history.get', 200, {
      card_id: CARD,
      version: 1,
      entry_id: '11111111-1111-4111-8111-111111111111',
      published_at: '2026-01-01T00:00:00.000Z',
      artifact,
    })).toThrow();
  });
});
