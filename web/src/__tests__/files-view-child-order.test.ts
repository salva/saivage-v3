import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import FilesView from '../views/FilesView.vue';
import { useCardStore } from '../stores/cards';
import { cardView, hierarchyView } from './card-view-fixtures';

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: vi.fn() }) }));

const PARENT_ID = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const childId = (segment: string) => `${PARENT_ID}-${segment.repeat(28)}`;

describe('FilesView committed child order', () => {
  it('renders linked children in the parent children order', async () => {
    setActivePinia(createPinia());
    const cardsStore = useCardStore();
    const orderedIds = [childId('e'), childId('b'), childId('d'), childId('a'), childId('c')];
    const parent = hierarchyView(PARENT_ID, { type: 'goal', title: 'Parent A', status: 'running' });
    const children = [
      hierarchyView(orderedIds[0], { title: 'E' }),
      hierarchyView(orderedIds[1], { title: 'B' }),
      hierarchyView(orderedIds[2], { title: 'D' }),
      hierarchyView(orderedIds[3], { title: 'A' }),
      hierarchyView(orderedIds[4], { title: 'C' }),
    ];
    cardsStore.hierarchySlicesByParentId = { [PARENT_ID]: { parent, children } };
    cardsStore.selectedDetail = { cardId: PARENT_ID, card: cardView(PARENT_ID, { type: 'goal', title: 'Parent A', lifecycle: { status: 'running', result: null, error: null, completed_at: null } }) };
    const wrapper = mount(FilesView, { global: { stubs: { CodeBlock: true, MarkdownText: true } } });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="files-card-children-list"] [data-testid="files-card-children-item"] .title').map((n) => n.text())).toEqual(['E', 'B', 'D', 'A', 'C']);
  });
});
