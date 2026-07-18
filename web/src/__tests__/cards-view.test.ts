import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import CardsView from '../views/CardsView.vue';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';
import source from '../views/CardsView.vue?raw';
import detailSource from '../components/cards/CardDetailView.vue?raw';

const DetailStub = defineComponent({ props: { cardId: String }, emits: ['back-to-cards'], template: '<div data-testid="detail">detail {{ cardId }} <button data-testid="detail-back" @click="$emit(\'back-to-cards\')">Back to Cards</button></div>' });

async function mounted(path: string, includeSelectedEdge = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useCardStore();
  const child = cardView('card-a', { title: 'Hierarchy title' });
  store.hierarchySlicesByParentId = {
    project: { parent: cardView('project', { children: includeSelectedEdge ? ['card-a'] : [] }), children: includeSelectedEdge ? [child] : [] },
  };
  store.childrenLoadStateById = { project: { status: 'loaded', error: null, refreshing: false, stale: false, staleReason: null, refreshError: null } };
  vi.spyOn(store, 'ensureRoot').mockResolvedValue();
  vi.spyOn(store, 'ensureRouteVisible').mockResolvedValue();
  vi.spyOn(store, 'clearCardSelection');
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/cards', name: 'cards', component: CardsView },
    { path: '/cards/:id', name: 'card-detail', component: CardsView },
  ] });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(CardsView, { global: { plugins: [pinia, router], stubs: { CardDetailView: DetailStub } } });
  await nextTick();
  return { wrapper, store, router };
}

describe('CardsView lazy route semantics', () => {
  it('leaves root bootstrap to the application and owns stable-id route reveal', async () => {
    const { store } = await mounted('/cards/card-a');
    expect(store.ensureRoot).not.toHaveBeenCalled();
    expect(store.ensureRouteVisible).toHaveBeenCalledWith('card-a');
  });

  it('clears selection without hierarchy loss on root and invalid routes and never reveals invalid identity', async () => {
    const root = await mounted('/cards/card-a'); const slices = root.store.hierarchySlicesByParentId; const states = root.store.childrenLoadStateById;
    root.store.selectedCardId = 'card-a'; await root.router.push('/cards'); await nextTick();
    expect(root.store.clearCardSelection).toHaveBeenCalled(); expect(root.store.selectedCardId).toBeNull(); expect(root.store.hierarchySlicesByParentId).toBe(slices); expect(root.store.childrenLoadStateById).toBe(states);
    vi.mocked(root.store.ensureRouteVisible).mockClear(); root.store.selectedCardId = 'card-a'; await root.router.push('/cards/card-OLD'); await nextTick();
    expect(root.store.selectedCardId).toBeNull(); expect(root.store.ensureRouteVisible).not.toHaveBeenCalled(); expect(root.router.currentRoute.value.fullPath).toBe('/cards/card-OLD'); expect(root.wrapper.get('[data-testid="detail"]').text()).toContain('card-OLD');
  });

  it('pushes explicit detail recovery while retaining tree DOM and ordinary Back/Forward entries', async () => {
    const { wrapper, store, router } = await mounted('/cards/card-a'); const tree = wrapper.findComponent(CardsTreeView).element;
    store.selectedCardId = 'card-a'; store.selectedDetailError = { kind: 'not-found', status: 404, message: 'gone' }; await nextTick();
    expect(store.selectedCardId).toBe('card-a'); await wrapper.get('[data-testid="detail-back"]').trigger('click'); await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/cards'));
    expect(router.currentRoute.value.fullPath).toBe('/cards'); expect(store.selectedCardId).toBeNull(); expect(wrapper.findComponent(CardsTreeView).element).toBe(tree);
    router.back(); await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/cards/card-a')); expect(wrapper.get('[data-testid="detail"]').text()).toContain('card-a');
    router.forward(); await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/cards')); expect(wrapper.findComponent(CardsTreeView).element).toBe(tree);
  });

  it('keeps detail visible without a selected row when retained hierarchy omits the edge', async () => {
    const { wrapper } = await mounted('/cards/card-a', false);
    expect(wrapper.find('[data-testid="detail"]').text()).toContain('card-a');
    expect(wrapper.findAll('.tree-node.selected')).toHaveLength(0);
  });

  it('keeps the tree mounted while selected detail state changes', async () => {
    const { wrapper, store } = await mounted('/cards/card-a');
    const tree = wrapper.findComponent(CardsTreeView).element;
    store.selectedDetailLoading = true;
    await nextTick();
    expect(wrapper.findComponent(CardsTreeView).element).toBe(tree);
    store.selectedDetailError = { kind: 'network', status: null, message: 'detail failed' };
    store.selectedDetailLoading = false;
    await nextTick();
    expect(wrapper.findComponent(CardsTreeView).element).toBe(tree);
  });

  it('continues route reveal only after a relevant successful slice replacement', async () => {
    const { store } = await mounted('/cards/card-a-b', false);
    vi.mocked(store.ensureRouteVisible).mockClear();
    store.hierarchySlicesByParentId = { ...store.hierarchySlicesByParentId, 'card-z': { parent: cardView('card-z'), children: [] } };
    await nextTick();
    expect(store.ensureRouteVisible).not.toHaveBeenCalled();
    store.childrenLoadStateById = { ...store.childrenLoadStateById, project: { status: 'loaded', error: null, refreshing: false, stale: false, staleReason: null, refreshError: null } };
    store.hierarchySlicesByParentId = { ...store.hierarchySlicesByParentId, project: { parent: cardView('project', { children: ['card-a'] }), children: [cardView('card-a', { children: ['card-a-b'] })] } };
    await nextTick();
    expect(store.ensureRouteVisible).toHaveBeenCalledTimes(1);
    expect(store.ensureRouteVisible).toHaveBeenCalledWith('card-a-b');
  });

  it('contains no global collection refresh or detail-owned path contract', () => {
    expect(source).not.toContain('fetchCards');
    expect(source).not.toContain('refetch');
    expect(detailSource).toContain('hierarchyPathFor');
    expect(detailSource).not.toContain('currentCard.logical_path');
  });
});
