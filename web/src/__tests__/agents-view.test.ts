/**
 * Bounded component-level regression tests for AgentsView.
 *
 * Tests cover:
 *  1. Operator interaction: selecting a session and returning to the list (back)
 *  2. Operator interaction: clicking session cards selects the correct session
 *  3. Operator interaction: navigating to detail view via route param
 *  4. Visible presentation: loading state
 *  5. Visible presentation: error state
 *  6. Visible presentation: empty state (no sessions)
 *  7. Visible presentation: role-grouped session list rendering with status-based styling
 *
 * The API client, WebSocket store, and child AgentConversationView are fully
 * mocked — no server needed.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import AgentsView from '../views/AgentsView.vue';
import type { AgentSession, AgentRole } from '../api/types';

// ── Reactive state for ws mock ────────────────────────────────
let wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();

function resetTestState() {
  wsTypeHandlers = new Map();
}

// ── Mock the WebSocket store ──────────────────────────────────
vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    connectionState: ref('connected'),
    get sessionId() { return 'sess-agents-001'; },
    reconnectAttempts: ref(0),
    onType: (type: string, handler: (envelope: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) { set = new Set(); wsTypeHandlers.set(type, set); }
      set.add(handler);
      return () => { set?.delete(handler); };
    },
    sendMessage: vi.fn(),
    isConnected: () => true,
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
    getAgentConversation: vi.fn(),
    ApiError,
  };
});

import { getAgentConversation } from '../api/client';

// ── Mock child AgentConversationView ──────────────────────────
vi.mock('../components/agents/AgentConversationView.vue', () => ({
  default: {
    name: 'AgentConversationView',
    template: '<div class="mock-conversation-view">Conversation Stub (sessionId: {{ sessionId }})</div>',
    props: ['sessionId'],
  },
}));

// ── Fixtures ──────────────────────────────────────────────────

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  const id = overrides.id || `sess-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    role: 'planner' as AgentRole,
    goal_card_id: 'goal-1',
    card_id: 'card-1',
    status: 'active' as const,
    started_at: '2025-06-01T08:00:00Z',
    completed_at: null,
    model: 'claude-sonnet-4',
    ...overrides,
  };
}

const plannerSession = makeSession({ id: 'planner-1', role: 'planner', status: 'active' });
const executorSession = makeSession({ id: 'executor-1', role: 'executor', status: 'active', model: 'deepseek-v4-pro' });
const reviewerSession = makeSession({ id: 'reviewer-1', role: 'reviewer', status: 'done', completed_at: '2025-06-01T09:00:00Z' });
const analystSession = makeSession({ id: 'analyst-1', role: 'analyst', status: 'done', completed_at: '2025-06-01T10:00:00Z', model: 'gpt-5' });
const failedSession = makeSession({ id: 'failed-1', role: 'executor', status: 'failed', completed_at: '2025-06-01T08:30:00Z' });

const allSessions = [plannerSession, executorSession, reviewerSession, analystSession, failedSession];

// ── Router ────────────────────────────────────────────────────
function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/agents', name: 'agents', component: AgentsView },
      { path: '/agents/:id', name: 'agent-detail', component: AgentsView },
    ],
  });
}

// ── Mount helper ──────────────────────────────────────────────
async function mountAgentsView(opts?: {
  sessions?: AgentSession[];
  /** Route to navigate to before mount. Default: '/agents' for list view. */
  initialRoute?: string;
}) {
  resetTestState();
  setActivePinia(createPinia());

  const router = makeRouter();
  await router.push(opts?.initialRoute ?? '/agents');
  await router.isReady();

  const wrapper = mount(AgentsView, {
    global: { plugins: [createPinia(), router] },
  });
  await flushPromises();

  // Pre-populate the store with sessions
  if (opts?.sessions) {
    const { useAgentStore } = await import('../stores/agents');
    const store = useAgentStore();
    for (const s of opts.sessions) {
      store.addSession(s);
    }
    await flushPromises();
  }

  return { wrapper, router };
}

// ── Tests ─────────────────────────────────────────────────────
describe('AgentsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestState();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  // ── Visible Presentation: Role-Grouped Session List ────────

  describe('visible presentation — role-grouped session list', () => {
    it('renders role sections for each distinct role', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      const headings = wrapper.findAll('.role-heading');
      // Role headings include icon prefix like "(PL)" and count badge; strip both for the role name
      const roleTexts = headings.map(h => {
        const t = h.text();
        // Remove the icon like "(PL)", "(EX)", etc. at the start, and the count number at the end
        return t.replace(/^\([A-Z?]+\)\s*/, '').replace(/\s*\d+$/, '').trim();
      });
      expect(roleTexts).toContain('planner');
      expect(roleTexts).toContain('executor');
      expect(roleTexts).toContain('reviewer');
      expect(roleTexts).toContain('analyst');
    });

    it('shows role count badge per role section', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      const counts = wrapper.findAll('.role-count');
      const countTexts = counts.map(c => c.text());
      // planner:1, executor:2 (executor-1 + failed-1), reviewer:1, analyst:1
      expect(countTexts).toContain('1');
      expect(countTexts).toContain('2');
    });

    it('renders session cards with correct status classes', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      const activeCards = wrapper.findAll('.session-card.status-active');
      const doneCards = wrapper.findAll('.session-card.status-done');
      const failedCards = wrapper.findAll('.session-card.status-failed');

      // planner-1 and executor-1 are active
      expect(activeCards.length).toBeGreaterThanOrEqual(2);
      // reviewer-1 and analyst-1 are done
      expect(doneCards.length).toBeGreaterThanOrEqual(2);
      // failed-1 is failed
      expect(failedCards.length).toBeGreaterThanOrEqual(1);
    });

    it('renders status dot elements on session cards', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      const activeDots = wrapper.findAll('.session-status-dot.s-active');
      const doneDots = wrapper.findAll('.session-status-dot.s-done');
      const failedDots = wrapper.findAll('.session-status-dot.s-failed');

      expect(activeDots.length).toBeGreaterThanOrEqual(2);
      expect(doneDots.length).toBeGreaterThanOrEqual(2);
      expect(failedDots.length).toBeGreaterThanOrEqual(1);
    });

    it('displays model name on session cards', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      const modelLabels = wrapper.findAll('.session-model');
      const modelTexts = modelLabels.map(l => l.text());
      expect(modelTexts).toContain('claude-sonnet-4');
      expect(modelTexts).toContain('deepseek-v4-pro');
      expect(modelTexts).toContain('gpt-5');
    });

    it('shows "default" model when model is not set', async () => {
      const session = makeSession({ id: 'no-model', role: 'planner', model: undefined });
      const { wrapper } = await mountAgentsView({ sessions: [session] });

      const modelLabels = wrapper.findAll('.session-model');
      expect(modelLabels.some(l => l.text().trim() === 'default')).toBe(true);
    });

    it('displays goal_card_id and card_id on session cards', async () => {
      const { wrapper } = await mountAgentsView({ sessions: [plannerSession] });

      // plannerSession has goal_card_id='goal-1' and card_id='card-1'
      const goalSpans = wrapper.findAll('.session-goal');
      const cardRefs = wrapper.findAll('.session-card-ref');
      expect(goalSpans.length).toBeGreaterThanOrEqual(1);
      expect(goalSpans[0].text()).toContain('goal-1');
      expect(cardRefs.length).toBeGreaterThanOrEqual(1);
      expect(cardRefs[0].text()).toContain('card-1');
    });

    it('renders formatted date for started_at', async () => {
      const { wrapper } = await mountAgentsView({ sessions: [plannerSession] });

      const timeDiv = wrapper.find('.session-time');
      expect(timeDiv.exists()).toBe(true);
      expect(timeDiv.text()).toContain('Started:');
    });
  });

  // ── Visible Presentation: Loading State ────────────────────

  describe('visible presentation — loading state', () => {
    it('shows "Loading agents..." when the store is in loading state', async () => {
      resetTestState();
      setActivePinia(createPinia());

      const router = makeRouter();
      await router.push('/agents');
      await router.isReady();

      const wrapper = mount(AgentsView, {
        global: { plugins: [createPinia(), router] },
      });
      await flushPromises();

      // Manually set loading on the store before any data arrives
      const { useAgentStore } = await import('../stores/agents');
      const store = useAgentStore();
      store.loading = true;
      await flushPromises();

      expect(wrapper.find('.agents-loading').exists()).toBe(true);
      expect(wrapper.find('.agents-loading').text()).toBe('Loading agents...');

      // Clear loading
      store.loading = false;
      await flushPromises();

      expect(wrapper.find('.agents-loading').exists()).toBe(false);
    });
  });

  // ── Visible Presentation: Error State ──────────────────────

  describe('visible presentation — error state', () => {
    it('shows error message when store has error', async () => {
      resetTestState();
      setActivePinia(createPinia());

      const router = makeRouter();
      await router.push('/agents');
      await router.isReady();

      const wrapper = mount(AgentsView, {
        global: { plugins: [createPinia(), router] },
      });
      await flushPromises();

      const { useAgentStore } = await import('../stores/agents');
      const store = useAgentStore();
      store.error = 'Failed to load agent sessions';
      await flushPromises();

      expect(wrapper.find('.agents-error').exists()).toBe(true);
      expect(wrapper.find('.agents-error').text()).toBe('Failed to load agent sessions');
    });
  });

  // ── Visible Presentation: Empty State ──────────────────────

  describe('visible presentation — empty state', () => {
    it('shows "No agent sessions recorded yet." when no sessions exist', async () => {
      const { wrapper } = await mountAgentsView({ sessions: [] });

      expect(wrapper.find('.agents-empty').exists()).toBe(true);
      expect(wrapper.find('.agents-empty').text()).toBe('No agent sessions recorded yet.');
    });

    it('does not show empty state when sessions exist', async () => {
      const { wrapper } = await mountAgentsView({ sessions: [plannerSession] });

      expect(wrapper.find('.agents-empty').exists()).toBe(false);
    });
  });

  // ── Operator Interaction: Session Selection ────────────────

  describe('operator interaction — session selection', () => {
    it('selects a session and shows detail view when a session card is clicked', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      // Should be in list mode initially
      expect(wrapper.find('.detail-header-bar').exists()).toBe(false);
      expect(wrapper.find('.agents-content').exists()).toBe(true);

      // Click the planner session card
      const cards = wrapper.findAll('.session-card');
      const plannerCard = cards.find(c => c.find('.session-model').text() === 'claude-sonnet-4');
      expect(plannerCard).toBeTruthy();

      await plannerCard!.trigger('click');
      await flushPromises();

      // Should now be in detail mode
      expect(wrapper.find('.detail-header-bar').exists()).toBe(true);
      expect(wrapper.find('.agent-session-id').text()).toBe('planner-1');
      expect(wrapper.find('.mock-conversation-view').exists()).toBe(true);
      expect(wrapper.find('.mock-conversation-view').text()).toContain('sessionId: planner-1');
    });

    it('renders back button in detail view', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      // Select a session
      const cards = wrapper.findAll('.session-card');
      await cards[0].trigger('click');
      await flushPromises();

      const backBtn = wrapper.find('.back-btn');
      expect(backBtn.exists()).toBe(true);
      expect(backBtn.text()).toBe('Back to Agents');
    });

    it('returns to agent list when back button is clicked', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      // Select a session first
      const cards = wrapper.findAll('.session-card');
      await cards[0].trigger('click');
      await flushPromises();
      expect(wrapper.find('.detail-header-bar').exists()).toBe(true);

      // Click back
      await wrapper.find('.back-btn').trigger('click');
      await flushPromises();

      // Should be back in list mode
      expect(wrapper.find('.detail-header-bar').exists()).toBe(false);
      expect(wrapper.find('.agents-content').exists()).toBe(true);
      expect(wrapper.findAll('.session-card').length).toBeGreaterThanOrEqual(1);
    });

    it('clears selected session when back is clicked (resets to null)', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      // Select → back → verify list is shown
      await wrapper.findAll('.session-card')[0].trigger('click');
      await flushPromises();
      await wrapper.find('.back-btn').trigger('click');
      await flushPromises();

      // Should show the list, not the detail
      expect(wrapper.find('.agents-content').exists()).toBe(true);
      expect(wrapper.find('.detail-header-bar').exists()).toBe(false);
    });

    it('navigates to detail via route param (/agents/:id)', async () => {
      const { wrapper } = await mountAgentsView({
        sessions: allSessions,
        initialRoute: '/agents/planner-1',
      });

      // Should be in detail mode from route (watch with immediate:true fires on mount)
      expect(wrapper.find('.detail-header-bar').exists()).toBe(true);
      expect(wrapper.find('.agent-session-id').text()).toBe('planner-1');
      expect(wrapper.find('.mock-conversation-view').exists()).toBe(true);
    });
  });

  // ── Operator Interaction: Edge Cases ───────────────────────

  describe('operator interaction — edge cases', () => {
    it('can switch between different sessions', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      // Select first session
      const cards = wrapper.findAll('.session-card');
      await cards[0].trigger('click');
      await flushPromises();
      const firstId = wrapper.find('.agent-session-id').text();

      // Back to list
      await wrapper.find('.back-btn').trigger('click');
      await flushPromises();

      // Select a different session
      await cards[2].trigger('click');
      await flushPromises();
      const secondId = wrapper.find('.agent-session-id').text();

      expect(firstId).not.toBe(secondId);
    });

    it('shows detail for a session with all status types', async () => {
      const { wrapper } = await mountAgentsView({ sessions: allSessions });

      // Select the failed session
      const cards = wrapper.findAll('.session-card');
      const failedCard = cards.find(c => c.find('.session-status-badge.s-failed').exists());
      expect(failedCard).toBeTruthy();

      await failedCard!.trigger('click');
      await flushPromises();

      expect(wrapper.find('.detail-header-bar').exists()).toBe(true);
      expect(wrapper.find('.mock-conversation-view').exists()).toBe(true);
    });
  });
});
