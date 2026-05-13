/**
 * Bounded component-level regression tests for CardsView.
 *
 * Tests cover:
 *  1. Operator interaction: switching view tabs (Tree→Board→Timeline→Leaderboard)
 *  2. Operator interaction: search/filter input triggers filtered view
 *  3. Operator interaction: navigating to card detail via selectCard
 *  4. Operator interaction: back navigation from detail view
 *  5. Visible presentation: loading state
 *  6. Visible presentation: error state
 *  7. Visible presentation: empty tree state
 *  8. Visible presentation: detail mode rendering
 *
 * The API client, WebSocket store, and child card components are fully
 * mocked — no server needed.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import CardsView from '../views/CardsView.vue';
import type { CardRecord, CardListResponse } from '../api/types';

// ── Reactive state for ws mock ────────────────────────────────
let mockWsIsConnected = true;
let wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();

function resetTestState() {
  mockWsIsConnected = true;
  wsTypeHandlers = new Map();
}

// ── Mock the WebSocket store ──────────────────────────────────
vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    connectionState: ref('connected'),
    get sessionId() { return 'sess-card-001'; },
    reconnectAttempts: ref(0),
    onType: (type: string, handler: (envelope: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) { set = new Set(); wsTypeHandlers.set(type, set); }
      set.add(handler);
      return () => { set?.delete(handler); };
    },
    sendMessage: vi.fn(),
    isConnected: () => mockWsIsConnected,
    isConnecting: () => false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

// ── Mock the API client ───────────────────────────────────────
vi.mock('../api/client', () => {
  const ApiError = class extends Error {
    status: number; body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message); this.name = 'ApiError'; this.status = status; this.body = body;
    }
  };
  return {
    listCards: vi.fn(), getCard: vi.fn(), createCard: vi.fn(),
    updateCard: vi.fn(), deleteCard: vi.fn(), ApiError,
  };
});

import { listCards } from '../api/client';

// ── Mock child card components ────────────────────────────────
vi.mock('../components/cards/CardsTreeView.vue', () => ({
  default: {
    name: 'CardsTreeView',
    template: '<div class="mock-tree-view">Tree View Stub ({{ cards.length }} cards)</div>',
    props: ['cards', 'tree', 'expandedIds'],
    emits: ['toggle', 'select', 'action'],
  },
}));

vi.mock('../components/cards/CardsBoardView.vue', () => ({
  default: {
    name: 'CardsBoardView',
    template: '<div class="mock-board-view">Board View Stub ({{ filteredCards.length }} cards)</div>',
    props: ['board', 'filteredCards'],
    emits: ['select', 'move'],
  },
}));

vi.mock('../components/cards/CardsLeaderboardView.vue', () => ({
  default: {
    name: 'CardsLeaderboardView',
    template: '<div class="mock-leaderboard-view">Leaderboard View Stub ({{ cards.length }} cards)</div>',
    props: ['cards'],
    emits: ['select'],
  },
}));

vi.mock('../components/cards/CardsTimelineView.vue', () => ({
  default: {
    name: 'CardsTimelineView',
    template: '<div class="mock-timeline-view">Timeline View Stub ({{ cards.length }} cards)</div>',
    props: ['cards'],
    emits: ['select'],
  },
}));

vi.mock('../components/cards/CardDetailView.vue', () => ({
  default: {
    name: 'CardDetailView',
    template: '<div class="mock-detail-view">Detail View Stub (cardId: {{ cardId }})</div>',
    props: ['cardId'],
    emits: ['navigate'],
  },
}));

// ── Fixtures ──────────────────────────────────────────────────
function makeCard(overrides: Partial<CardRecord> = {}): CardRecord {
  const id = overrides.id || `c-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id, type: 'code', parent: null, depth: 0,
    title: `Card ${id}`, description: 'test card',
    status: 'active', tags: [], priority: 5, urgency: 'normal',
    created_by: 'user', created_at: '2025-06-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
    depends_on: [], blocks: [], related: [],
    acceptance: '', artifacts: [], attachments: [],
    retries: 0, ...overrides,
  };
}

const projectCard = makeCard({ id: 'proj-1', type: 'project', title: 'Saivage v3', status: 'active', priority: 10, tags: ['core'] });
const goalCard = makeCard({ id: 'goal-1', type: 'goal', title: 'Build UI', status: 'running', parent: 'proj-1', priority: 8 });
const planCard = makeCard({ id: 'plan-1', type: 'plan', title: 'UI Plan', status: 'done', parent: 'goal-1', priority: 7 });
const codeCard = makeCard({ id: 'code-1', type: 'code', title: 'CardsView.vue', status: 'running', parent: 'plan-1', priority: 6, tags: ['frontend'] });
const testCard = makeCard({ id: 'test-1', type: 'test', title: 'CardsView tests', status: 'drafting', parent: 'plan-1', priority: 5 });
const allCards = [projectCard, goalCard, planCard, codeCard, testCard];

function mlr(cards: CardRecord[], total?: number): CardListResponse {
  return { cards, total: total ?? cards.length };
}

// ── Router ────────────────────────────────────────────────────
function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/cards', name: 'cards', component: CardsView },
      { path: '/cards/:id', name: 'card-detail', component: CardsView },
    ],
  });
}

// ── Mount helper ──────────────────────────────────────────────
async function mountCardsView(opts?: {
  cards?: CardRecord[];
  /** Route to navigate to before mount. Default: '/cards' for list view. */
  initialRoute?: string;
}) {
  resetTestState();
  const pinia = createPinia();

  vi.mocked(listCards).mockResolvedValue(mlr(opts?.cards ?? allCards));

  const router = makeRouter();
  // Navigate to the desired route before mounting
  await router.push(opts?.initialRoute ?? '/cards');
  await router.isReady();

  const wrapper = mount(CardsView, {
    global: { plugins: [pinia, router] },
  });
  await flushPromises();
  return { wrapper, router };
}

// ── Tests ─────────────────────────────────────────────────────
describe('CardsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestState();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('operator interaction — view tab switching', () => {
    it('renders Tree view by default (activeView = "tree")', async () => {
      const { wrapper } = await mountCardsView();
      expect(wrapper.find('.mock-tree-view').exists()).toBe(true);
      expect(wrapper.find('.mock-board-view').exists()).toBe(false);
    });

    it('switches to Board view when Board tab is clicked', async () => {
      const { wrapper } = await mountCardsView();
      const tabs = wrapper.findAll('.view-tab');
      const boardTab = tabs.find(t => t.text().trim() === 'Board');
      expect(boardTab).toBeTruthy();

      await boardTab!.trigger('click');
      await flushPromises();

      expect(wrapper.find('.mock-tree-view').exists()).toBe(false);
      expect(wrapper.find('.mock-board-view').exists()).toBe(true);
      expect(boardTab!.classes()).toContain('active');
    });

    it('switches to Timeline view when Timeline tab is clicked', async () => {
      const { wrapper } = await mountCardsView();
      const tabs = wrapper.findAll('.view-tab');
      const timelineTab = tabs.find(t => t.text().trim() === 'Timeline');
      expect(timelineTab).toBeTruthy();

      await timelineTab!.trigger('click');
      await flushPromises();

      expect(wrapper.find('.mock-timeline-view').exists()).toBe(true);
      expect(timelineTab!.classes()).toContain('active');
    });

    it('switches to Leaderboard view when Leaderboard tab is clicked', async () => {
      const { wrapper } = await mountCardsView();
      const tabs = wrapper.findAll('.view-tab');
      const lbTab = tabs.find(t => t.text().trim() === 'Leaderboard');
      expect(lbTab).toBeTruthy();

      await lbTab!.trigger('click');
      await flushPromises();

      expect(wrapper.find('.mock-leaderboard-view').exists()).toBe(true);
      expect(lbTab!.classes()).toContain('active');
    });

    it('cycles through all four tabs and only active tab gets .active', async () => {
      const { wrapper } = await mountCardsView();
      const tabs = wrapper.findAll('.view-tab');
      expect(tabs).toHaveLength(4);

      for (const tab of tabs) {
        await tab.trigger('click');
        await flushPromises();
        for (const t of tabs) {
          if (t === tab) {
            expect(t.classes()).toContain('active');
          } else {
            expect(t.classes()).not.toContain('active');
          }
        }
      }
    });
  });

  describe('operator interaction — search/filter', () => {
    it('renders search input and accepts typing', async () => {
      const { wrapper } = await mountCardsView();
      const searchInput = wrapper.find('.search-input');
      expect(searchInput.exists()).toBe(true);

      await searchInput.setValue('CardsView');
      expect((searchInput.element as HTMLInputElement).value).toBe('CardsView');
    });

    it('renders status filter with all status options', async () => {
      const { wrapper } = await mountCardsView();
      const filterSelects = wrapper.findAll('.filter-select');
      expect(filterSelects.length).toBeGreaterThanOrEqual(2);

      const statusSelect = filterSelects[0];
      const options = statusSelect.findAll('option');
      expect(options.length).toBeGreaterThan(1);
      expect(options[0].text()).toBe('All Statuses');
    });

    it('renders type filter with type options', async () => {
      const { wrapper } = await mountCardsView();
      const filterSelects = wrapper.findAll('.filter-select');
      const typeSelect = filterSelects[1];
      const options = typeSelect.findAll('option');
      expect(options.length).toBeGreaterThan(1);
      expect(options[0].text()).toBe('All Types');
    });

    it('renders tag filter with tags collected from cards', async () => {
      const { wrapper } = await mountCardsView();
      const filterSelects = wrapper.findAll('.filter-select');
      const tagSelect = filterSelects[2];
      const options = tagSelect.findAll('option');
      expect(options.length).toBeGreaterThan(1);
      const texts = options.map(o => o.text());
      expect(texts).toContain('core');
      expect(texts).toContain('frontend');
    });
  });

  describe('operator interaction — navigation to detail and back', () => {
    it('navigates to card detail when selectCard is triggered via tree view emit', async () => {
      const { wrapper } = await mountCardsView();
      const treeStub = wrapper.findComponent({ name: 'CardsTreeView' });
      expect(treeStub.exists()).toBe(true);

      await treeStub.vm.$emit('select', 'code-1');
      await flushPromises();

      expect(wrapper.find('.mock-detail-view').exists()).toBe(true);
      expect(wrapper.find('.back-btn').exists()).toBe(true);
      expect(wrapper.find('.card-id-path').text()).toBe('code-1');
    });

    it('back button returns to cards list from detail view', async () => {
      const { wrapper } = await mountCardsView();
      // Navigate to detail first
      const treeStub = wrapper.findComponent({ name: 'CardsTreeView' });
      await treeStub.vm.$emit('select', 'code-1');
      await flushPromises();
      expect(wrapper.find('.mock-detail-view').exists()).toBe(true);

      // Click back
      await wrapper.find('.back-btn').trigger('click');
      await flushPromises();

      expect(wrapper.find('.mock-tree-view').exists()).toBe(true);
      expect(wrapper.find('.mock-detail-view').exists()).toBe(false);
    });
  });

  describe('visible presentation — loading state', () => {
    it('shows "Loading cards..." while store is loading', async () => {
      resetTestState();
      const pinia = createPinia();

      // Defer listCards so loading stays true
      let resolveList: (v: any) => void;
      const pending = new Promise<any>(r => { resolveList = r; });
      vi.mocked(listCards).mockReturnValue(pending);

      const router = makeRouter();
      await router.push('/cards');
      await router.isReady();

      const wrapper = mount(CardsView, {
        global: { plugins: [pinia, router] },
      });
      await flushPromises();

      expect(wrapper.find('.cards-loading').exists()).toBe(true);
      expect(wrapper.find('.cards-loading').text()).toBe('Loading cards...');

      // Resolve and loading should disappear
      resolveList!(mlr(allCards));
      await flushPromises();

      expect(wrapper.find('.cards-loading').exists()).toBe(false);
      expect(wrapper.find('.mock-tree-view').exists()).toBe(true);
    });
  });

  describe('visible presentation — error state', () => {
    it('shows error message when fetchCards fails', async () => {
      resetTestState();
      const pinia = createPinia();

      vi.mocked(listCards).mockRejectedValue(new Error('Network failure'));

      const router = makeRouter();
      await router.push('/cards');
      await router.isReady();

      const wrapper = mount(CardsView, {
        global: { plugins: [pinia, router] },
      });
      await flushPromises();

      expect(wrapper.find('.cards-error').exists()).toBe(true);
      expect(wrapper.find('.cards-error').text()).toBe('Network failure');
    });
  });

  describe('visible presentation — empty tree state', () => {
    it('shows tree stub with 0 cards when no cards exist', async () => {
      const { wrapper } = await mountCardsView({ cards: [] });
      expect(wrapper.find('.mock-tree-view').exists()).toBe(true);
      expect(wrapper.find('.mock-tree-view').text()).toContain('0 cards');
    });
  });

  describe('visible presentation — detail mode', () => {
    it('renders detail view with back button and card ID path when on /cards/:id', async () => {
      const { wrapper } = await mountCardsView({ initialRoute: '/cards/code-1' });

      expect(wrapper.find('.mock-detail-view').exists()).toBe(true);
      expect(wrapper.find('.back-btn').exists()).toBe(true);
      expect(wrapper.find('.card-id-path').text()).toBe('code-1');
      expect(wrapper.find('.cards-toolbar').exists()).toBe(false);
    });

    it('detail view passes cardId prop to CardDetailView', async () => {
      const { wrapper } = await mountCardsView({ initialRoute: '/cards/goal-1' });

      const detailStub = wrapper.find('.mock-detail-view');
      expect(detailStub.exists()).toBe(true);
      expect(detailStub.text()).toContain('cardId: goal-1');
    });
  });

  describe('visible presentation — toolbar and new card button', () => {
    it('renders the toolbar with all four view tabs in list mode', async () => {
      const { wrapper } = await mountCardsView();
      expect(wrapper.find('.cards-toolbar').exists()).toBe(true);
      expect(wrapper.findAll('.view-tab')).toHaveLength(4);
    });

    it('renders "+ New Card" button in list mode', async () => {
      const { wrapper } = await mountCardsView();
      const newCardBtn = wrapper.find('.new-card-btn');
      expect(newCardBtn.exists()).toBe(true);
      expect(newCardBtn.text()).toContain('New Card');
    });

    it('hides toolbar when in detail mode', async () => {
      const { wrapper } = await mountCardsView({ initialRoute: '/cards/code-1' });
      expect(wrapper.find('.cards-toolbar').exists()).toBe(false);
    });
  });
});
