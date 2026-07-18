import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import FilesView from '../views/FilesView.vue';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: vi.fn() }) }));

const PARENT_ID = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const childId = (segment: string) => `${PARENT_ID}-${segment.repeat(28)}`;

describe('FilesView committed child order', () => {
  it('renders linked children in the parent children order', async () => {
    setActivePinia(createPinia());
    const cardsStore = useCardStore();
    const orderedIds = [childId('e'), childId('b'), childId('d'), childId('a'), childId('c')];
    const parent = cardView(PARENT_ID, { type: 'goal', children: orderedIds, title: 'Parent A', status: 'running' });
    const children = [
      cardView(orderedIds[0], { title: 'E' }),
      cardView(orderedIds[1], { title: 'B' }),
      cardView(orderedIds[2], { title: 'D' }),
      cardView(orderedIds[3], { title: 'A' }),
      cardView(orderedIds[4], { title: 'C' }),
    ];
    cardsStore.hierarchySlicesByParentId = { [PARENT_ID]: { parent, children } };
    cardsStore.selectedDetail = { cardId: PARENT_ID, card: parent };
    const wrapper = mount(FilesView, { global: { stubs: { CodeBlock: true, MarkdownText: true } } });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="files-card-children-list"] [data-testid="files-card-children-item"] .title').map((n) => n.text())).toEqual(['E', 'B', 'D', 'A', 'C']);
  });
});
