import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import type { CardRecord } from '../api/types';
import { useCardStore } from '../stores/cards';
import CardsView from '../views/CardsView.vue';
import source from '../views/CardsView.vue?raw';
import agentsSource from '../views/AgentsView.vue?raw';
import dashboardSource from '../views/DashboardView.vue?raw';
import timelineSource from '../views/TimelineView.vue?raw';
import entityInspectorSource from '../components/layout/EntityInspectorShell.vue?raw';
import cardDetailSource from '../components/cards/CardDetailView.vue?raw';

const removedCardsFilterTokens = new RegExp([
  ['Search', ' cards'].join(''),
  ['Filter by ', 'status'].join(''),
  ['Filter by ', 'type'].join(''),
  ['Any ', 'status'].join(''),
  ['Any ', 'type'].join(''),
  ['cards', '-filters'].join(''),
  ['filter', '-search'].join(''),
  ['filter', '-clear'].join(''),
  ['filter', 'Status'].join(''),
  ['filter', 'Type'].join(''),
  ['search', 'Query'].join(''),
  ['clear', 'Filters'].join(''),
  ['apply', 'Filters'].join(''),
].join('|'));

function projectCard(): CardRecord {
  return {
    id: 'project', type: 'project', parent: null, depth: 0, position: 0, children: [], title: 'Project', status: 'running',
    tags: [], priority: 1, urgency: 'normal', created_by: 'user', created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], pending_notifications: [],
    logical_path: 'Project',
    operator_summary: {
      lifecycleStatus: 'running', terminal: false, blocked: false, hasError: false, error: null,
      completedAt: null, stale: false, actionCount: 0,
    },
    lifecycle: { status: 'running', result: null, error: null, completed_at: null },
  };
}

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    ...projectCard(),
    id: '11111111-1111-4111-8111-111111111111',
    type: 'code',
    parent: 'project',
    depth: 1,
    title: 'Card',
    status: 'backlog',
    logical_path: null,
    ...overrides,
    lifecycle: overrides.lifecycle ?? { status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null },
  } as CardRecord;
}

const CardDetailStub = defineComponent({
  name: 'CardDetailView',
  props: { cardId: { type: String, required: true } },
  template: '<div data-testid="card-detail-stub"></div>',
});

async function mountCards(path: string, cards: CardRecord[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useCardStore();
  store.cards = cards;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/cards', name: 'cards', component: CardsView },
      { path: '/cards/:id', name: 'card-detail', component: CardsView },
    ],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(CardsView, {
    global: { plugins: [pinia, router], stubs: { CardDetailView: CardDetailStub } },
  });
  await nextTick();
  return { wrapper, router, store };
}

function selectedTitle(wrapper: VueWrapper): string {
  return wrapper.find('.tree-node.selected .node-title').text();
}

describe('CardsView read-only navigation contract', () => {
  it('exposes a contained route-owned root with no Cards filter affordances', () => {
    expect(source).toContain('data-testid="route-cards"');
    expect(source).toContain('class="cards-route"');
    expect(source).not.toMatch(removedCardsFilterTokens);
  });

  it('keeps the contained route and existing desktop/mobile pane scroll contracts', () => {
    expect(source).toContain('.cards-route { height: 100%; min-height: 0; overflow: hidden; }');
    expect(source).toContain('.cards-md__tree { flex: 1; overflow-y: auto; min-height: 0; }');
    expect(cardDetailSource).toContain('.card-detail-container { flex:1; min-height:0; overflow-y:auto;');
    expect(entityInspectorSource).toContain('.entity-inspector-shell.has-selection .entity-inspector-shell__list { display:none; }');
    expect(entityInspectorSource).toContain('.entity-inspector-shell.no-selection .entity-inspector-shell__detail { display:none; }');
    expect(entityInspectorSource).toContain('class="back-btn"');
  });

  it('keeps passive tree controls with no filter wiring or mutation affordances', () => {
    expect(source).toContain('@toggle="toggleTreeNode"');
    expect(source).toContain('@select="selectCard"');
    expect(source).not.toMatch(removedCardsFilterTokens);

    expect(source).not.toContain('Card Tree');
    expect(source).not.toContain('Open Timeline');
    expect(source).not.toContain('view-tab');

    expect(source).not.toMatch(/new card|create card|delete card|action-menu|delete-draft/i);
    expect(source).not.toMatch(/createCard|updateCard|deleteCard|newTitle|newPriority|creating/);
    expect(source).not.toMatch(/@drop|@dragstart|@dragover|handleKeydown/);
  });

  it('derives exact selection from direct routes, tree navigation, and history', async () => {
    const first = card({ id: '11111111-1111-4111-8111-111111111111', title: 'First card', status: 'running' });
    const second = card({ id: '22222222-2222-4222-8222-222222222222', title: 'Second card', status: 'done' });
    const { wrapper, router, store } = await mountCards(`/cards/${first.id}`, [projectCard(), first, second]);

    expect(selectedTitle(wrapper)).toBe('First card');
    expect(wrapper.findAll('[aria-current="true"]')).toHaveLength(1);
    expect('selectedCardId' in store).toBe(false);

    const secondRow = wrapper.findAll('.tree-node').find((row) => row.text().includes('Second card'))!;
    await secondRow.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.params.id).toBe(second.id);
    expect(selectedTitle(wrapper)).toBe('Second card');

    router.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(router.currentRoute.value.params.id).toBe(first.id);
    expect(selectedTitle(wrapper)).toBe('First card');

    router.forward();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(router.currentRoute.value.params.id).toBe(second.id);
    expect(selectedTitle(wrapper)).toBe('Second card');
  });

  it('keeps route selection across canonical card replacement without a route fetch', async () => {
    const selected = card({ id: '11111111-1111-4111-8111-111111111111', title: 'Before refresh' });
    const { wrapper, store } = await mountCards(`/cards/${selected.id}`, [projectCard(), selected]);
    const fetchCards = vi.spyOn(store, 'fetchCards');

    store.cards = [projectCard(), card({ id: selected.id, title: 'After refresh', status: 'changed' })];
    await nextTick();

    expect(selectedTitle(wrapper)).toBe('After refresh');
    expect(wrapper.find('.tree-node.selected .state-ball').classes()).toContain('card-status-changed');
    expect(fetchCards).not.toHaveBeenCalled();
  });

  it('keeps the tree and expansion intent mounted while route-selected detail is pending or failed', async () => {
    const first = card({ id: '11111111-1111-4111-8111-111111111111', title: 'First card', status: 'running' });
    const second = card({ id: '22222222-2222-4222-8222-222222222222', title: 'Second card', status: 'done' });
    const { wrapper, router, store } = await mountCards(`/cards/${first.id}`, [projectCard(), first, second]);
    const fetchCards = vi.spyOn(store, 'fetchCards');
    const tree = wrapper.findComponent(CardsTreeView);

    store.currentDetailLoading = true;
    await nextTick();
    expect(wrapper.findComponent(CardsTreeView).element).toBe(tree.element);
    expect(wrapper.text()).not.toContain('Loading cards');

    const secondRow = wrapper.findAll('.tree-node').find((row) => row.text().includes('Second card'))!;
    await secondRow.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.params.id).toBe(second.id);
    expect(selectedTitle(wrapper)).toBe('Second card');
    expect(wrapper.findComponent(CardsTreeView).element).toBe(tree.element);
    expect(wrapper.findComponent(CardsTreeView).props('expandedIds')).toEqual(new Set(['project']));
    expect(fetchCards).not.toHaveBeenCalled();

    store.currentDetailLoading = false;
    store.currentDetailError = { kind: 'network', status: null, message: 'detail unavailable' };
    await nextTick();
    expect(wrapper.findComponent(CardsTreeView).element).toBe(tree.element);
    expect(wrapper.text()).not.toContain('Could not load cards');
    expect(fetchCards).not.toHaveBeenCalled();
  });

  it('records collapse intent while route reveal keeps deep selection visible, then reapplies it', async () => {
    const goal = card({ id: '11111111-1111-4111-8111-111111111111', type: 'goal', title: 'Goal' });
    const leaf = card({ id: '22222222-2222-4222-8222-222222222222', parent: goal.id, depth: 2, title: 'Deep leaf', status: 'blocked' });
    const { wrapper, router } = await mountCards('/cards', [projectCard(), goal, leaf]);

    const projectToggle = wrapper.find('button.node-toggle');
    await projectToggle.trigger('click');
    expect(wrapper.findAll('.node-title').map((node) => node.text())).toEqual(['Project']);

    await router.push(`/cards/${leaf.id}`);
    await nextTick();
    expect(wrapper.findAll('.node-title').map((node) => node.text())).toEqual(['Project', 'Goal', 'Deep leaf']);
    expect(selectedTitle(wrapper)).toBe('Deep leaf');
    expect(wrapper.findAll('.tree-node.selected')).toHaveLength(1);
    expect(wrapper.findAll('button.node-toggle').every((toggle) => toggle.attributes('disabled') !== undefined)).toBe(true);
    expect(wrapper.findAll('button.node-toggle').map((toggle) => toggle.attributes('aria-label'))).toEqual([
      'Project: Expanded to show selected card',
      'Goal: Expanded to show selected card',
    ]);

    await router.push('/cards');
    await nextTick();
    expect(wrapper.findAll('.node-title').map((node) => node.text())).toEqual(['Project']);
    expect(wrapper.find('.tree-node.selected').exists()).toBe(false);
  });

  it('does not initiate unfiltered core reads from route mounts', () => {
    expect(source).not.toContain('fetchCards(');
    expect(timelineSource).not.toContain('fetchCards(');
    expect(agentsSource).not.toContain('fetchSessions(');
    expect(dashboardSource).not.toContain('onMounted');
  });

  it('reacts to late canonical cards with derived project expansion and no route fetch', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useCardStore();
    const fetchCards = vi.spyOn(store, 'fetchCards');
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/cards', name: 'cards', component: CardsView },
        { path: '/cards/:id', name: 'card-detail', component: CardsView },
      ],
    });
    await router.push('/cards');
    await router.isReady();
    const wrapper = mount(CardsView, { global: { plugins: [pinia, router] } });

    expect(fetchCards).not.toHaveBeenCalled();
    expect(wrapper.findComponent(CardsTreeView).props('expandedIds')).toEqual(new Set());
    store.cards = [projectCard()];
    await nextTick();
    expect(wrapper.findComponent(CardsTreeView).props('expandedIds')).toEqual(new Set(['project']));
    expect(fetchCards).not.toHaveBeenCalled();
  });
});
