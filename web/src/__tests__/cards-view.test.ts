import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
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

function projectCard(): CardRecord {
  return {
    id: 'project', type: 'project', parent: null, depth: 0, position: 0, title: 'Project', status: 'running',
    tags: [], priority: 1, urgency: 'normal', created_by: 'user', created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], pending_notifications: [],
    display_path: 'Project',
    operator_summary: {
      lifecycleStatus: 'running', terminal: false, blocked: false, hasError: false, error: null,
      completedAt: null, stale: false, actionCount: 0,
    },
    lifecycle: { status: 'running', result: null, error: null, completed_at: null },
  };
}

describe('CardsView read-only navigation contract', () => {
  it('exposes a route-owned root and route-body controls for browser smoke assertions', () => {
    expect(source).toContain('data-testid="route-cards"');
    expect(source).toContain('placeholder="Search…"');
    expect(source).toContain('aria-label="Filter by status"');
  });

  it('keeps passive tree controls and read-only filters, with no mutation affordances', () => {
    expect(source).toContain('@toggle="toggleTreeNode"');
    expect(source).toContain('@select="selectCard"');
    expect(source).toContain('filterStatus');
    expect(source).toContain('filterType');
    expect(source).toContain('searchQuery');
    expect(source).toContain('clearFilters');

    expect(source).not.toContain('Card Tree');
    expect(source).not.toContain('Open Timeline');
    expect(source).not.toContain('view-tab');

    expect(source).not.toMatch(/new card|create card|delete card|action-menu|delete-draft/i);
    expect(source).not.toMatch(/createCard|updateCard|deleteCard|newTitle|newPriority|creating/);
    expect(source).not.toMatch(/@drop|@dragstart|@dragover|handleKeydown/);
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
