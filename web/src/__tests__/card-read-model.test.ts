import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { useCardBrowserReadModel } from '../composables/useCardBrowserReadModel';
import { buildTree, selectLinkedChildren } from '../stores/cards';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';

const A_ID = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_ID = 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C_ID = `${A_ID}-cccccccccccccccccccccccccccc`;
const MISSING_ID = 'card-dddddddddddddddddddddddddddd';
const UNLINKED_ID = 'card-eeeeeeeeeeeeeeeeeeeeeeeeeeee';

describe('card selectors', () => {
  it('projects committed parent links and order from scrambled flat records', () => {
    const cards = [
      cardView(UNLINKED_ID, { title: 'Unlinked' }),
      cardView(C_ID, { title: 'Nested' }),
      cardView(A_ID, { children: [C_ID], title: 'A' }),
      cardView('project', { children: [B_ID, A_ID, MISSING_ID] }),
      cardView(B_ID, { title: 'B' }),
    ];

    const tree = buildTree(cards);
    expect(tree.map((entry) => entry.card.id)).toEqual(['project']);
    expect(tree[0].childNodes.map((entry) => entry.card.id)).toEqual([B_ID, A_ID]);
    expect(tree[0].childNodes[1].childNodes.map((entry) => entry.card.id)).toEqual([C_ID]);
    expect(selectLinkedChildren(cards, 'project').map((entry) => entry.id)).toEqual([B_ID, A_ID]);
    expect(selectLinkedChildren(cards, A_ID).map((entry) => entry.id)).toEqual([C_ID]);
    expect(tree.flatMap((entry) => entry.childNodes).some((entry) => entry.card.id === UNLINKED_ID)).toBe(false);
  });

  it('returns no roots when project is absent instead of promoting valid non-root rows', () => {
    expect(buildTree([cardView(A_ID), cardView(C_ID)])).toEqual([]);
  });

  it('derives late project expansion and preserves explicit collapse across canonical refreshes without fetching', () => {
    setActivePinia(createPinia());
    const store = useCardStore();
    const fetchCards = vi.spyOn(store, 'fetchCards');
    const model = useCardBrowserReadModel(store);

    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set());
    store.cards = [cardView('project')];
    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set(['project']));

    model.toggleTreeNode('project');
    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set());
    store.cards = [cardView('project', { title: 'Refreshed project' })];
    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set());

    model.toggleTreeNode('project');
    expect(model.effectiveExpandedTreeIds.value).toEqual(new Set(['project']));
    expect(fetchCards).not.toHaveBeenCalled();
  });
});
