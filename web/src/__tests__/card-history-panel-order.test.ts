import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CardHistoryPanel from '../components/cards/CardHistoryPanel.vue';
import { useCardStore } from '../stores/cards';
import { cardView, historyCard } from './card-view-fixtures';
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), getCard: vi.fn(), listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn() }));
import { listCardHistory, getCardHistoryEntry, getCardDiff } from '../api/client';
import { parseOperatorResponse } from '../api/contracts';
const CARD = 'card-a';
describe('CardHistoryPanel order', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => { vi.clearAllMocks(); pinia = createPinia(); setActivePinia(pinia); useCardStore().selectedDetail = { cardId: CARD, card: cardView(CARD, { version_seq: 3 }) }; });
  it('renders snapshot child IDs in backend order without resorting', async () => {
    const children = ['card-a-c', 'card-a-a', 'card-a-b'];
    const entryId = '11111111-1111-4111-8111-111111111111';
    const publishedAt = '2026-01-01T00:00:01.000Z';
    const header = { entry_id: entryId, version: 2, published_at: publishedAt, artifact_kind: 'card-version' as const };
    const snapshot = historyCard(CARD, { child_membership: children, active_child_order: children, version_seq: 2 });
    vi.mocked(listCardHistory).mockResolvedValue({ card_id: CARD, versions: [header], total: 1 });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ card_id: CARD, version: 2, entry_id: entryId, published_at: publishedAt, artifact: { kind: 'card-version', card: snapshot } });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: CARD, from: 2, to: 3, diff: [{ field: 'active_child_order', before: children, after: [] }] });
    const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } }); await flushPromises();
    const text = wrapper.text(); expect(text.indexOf('card-a-c')).toBeLessThan(text.indexOf('card-a-a')); expect(text.indexOf('card-a-a')).toBeLessThan(text.indexOf('card-a-b'));
    expect(text).toContain('child_membership');
    expect(text).toContain('active_child_order');
  });

  it('renders exact route versions in their ascending response order and selects the first version', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    vi.mocked(listCardHistory).mockResolvedValue({
      card_id: CARD,
      versions: [
        { entry_id: firstId, version: 1, published_at: '2026-01-01T00:00:00.000Z', artifact_kind: 'card-version' },
        { entry_id: secondId, version: 2, published_at: '2026-01-01T00:00:01.000Z', artifact_kind: 'card-version' },
      ],
      total: 2,
    });
    vi.mocked(getCardHistoryEntry).mockResolvedValue({
      card_id: CARD,
      version: 1,
      entry_id: firstId,
      published_at: '2026-01-01T00:00:00.000Z',
      artifact: { kind: 'card-version', card: historyCard(CARD) },
    });
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: CARD, from: 1, to: 3, diff: [] });

    const wrapper = mount(CardHistoryPanel, { props: { cardId: CARD }, global: { plugins: [pinia] } });
    await flushPromises();

    const items = wrapper.findAll('.history-item');
    expect(items).toHaveLength(2);
    expect(items[0]!.text()).toContain('v1');
    expect(items[1]!.text()).toContain('v2');
    expect(getCardHistoryEntry).toHaveBeenCalledWith(CARD, 1, expect.any(AbortSignal));
    expect(getCardDiff).toHaveBeenCalledWith({ cardId: CARD, fromSeq: 1, to: 'current' }, expect.any(AbortSignal));
  });

  it('strictly rejects the removed durable children field at the web response boundary', () => {
    const current = historyCard(CARD);
    const { child_membership: _membership, active_child_order: _order, ...withoutRelationships } = current;
    const artifact = { kind: 'card-version' as const, card: { ...withoutRelationships, children: [] } };
    expect(() => parseOperatorResponse('cards.history.get', 200, {
      card_id: CARD,
      version: 1,
      entry_id: '11111111-1111-4111-8111-111111111111',
      published_at: '2026-01-01T00:00:00.000Z',
      artifact,
    })).toThrow();
  });

  it('strictly rejects private queues and every removed public change shape', () => {
    const card = historyCard(CARD);
    const base = {
      card_id: CARD,
      version: 1,
      entry_id: '11111111-1111-4111-8111-111111111111',
      published_at: '2026-01-01T00:00:00.000Z',
    };
    expect(() => parseOperatorResponse('cards.history.get', 200, {
      ...base,
      artifact: { kind: 'card-version', card: { ...card, pending_notifications: [] } },
    })).toThrow();
    expect(() => parseOperatorResponse('cards.history.get', 200, {
      ...base,
      artifact: { kind: 'card-tombstone', final_card: { ...card, pending_notifications: [] } },
    })).toThrow();
    expect(() => parseOperatorResponse('cards.get', 200, {
      card: { ...cardView(CARD), pending_notifications: [] },
    })).toThrow();

    const changes = [
      null,
      {
        entry_id: base.entry_id,
        kind: 'update',
        card_id: CARD,
        resulting_version: 1,
        changed_at: base.published_at,
        changed_by_actor: 'planner',
        changed_by_surface: 'runtime',
        changed_fields: ['title'],
        change_summary: 'title updated',
        change_reason: 'planner edit_card',
        terminal_summary: null,
      },
      { entry_id: base.entry_id, version: 1, published_at: base.published_at, artifact_kind: 'card-version' },
    ];
    for (const change of changes) {
      expect(() => parseOperatorResponse('cards.history.get', 200, {
        ...base,
        artifact: { kind: 'card-version', card, change },
      })).toThrow();
    }
    expect(() => parseOperatorResponse('cards.history.list', 200, {
      card_id: CARD,
      versions: [{ entry_id: base.entry_id, version: 1, published_at: base.published_at, artifact_kind: 'card-version', change: changes[1] }],
      total: 1,
    })).toThrow();
    expect(() => parseOperatorResponse('cards.history.get', 200, {
      ...base,
      artifact: { kind: 'card-tombstone', final_card: card, change: changes[2] },
    })).toThrow();
  });
});
