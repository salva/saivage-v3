import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import AgentsView from '../views/AgentsView.vue';
import AgentConversationView from '../components/agents/AgentConversationView.vue';
import { useAgentStore } from '../stores/agents';
import type { AgentSession, AgentRole } from '../api/types';
const apiMockState = vi.hoisted(() => ({
  sessions: [] as AgentSession[],
  conversation: {
    session: null as AgentSession | null,
    entries: [] as any[],
  },
  listError: null as Error | null,
}));

let wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();

function resetTestState() {
  wsTypeHandlers = new Map();
  apiMockState.listError = null;
}

vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    connectionState: 'connected',
    sessionId: 'sess-agents-001',
    reconnectAttempts: 0,
    onType: (type: string, handler: (envelope: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) { set = new Set(); wsTypeHandlers.set(type, set); }
      set.add(handler);
      return () => { set?.delete(handler); };
    },
    onReconnect: vi.fn(() => () => {}),
    sendMessage: vi.fn(),
    isConnected: () => true,
    isConnecting: () => false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    stale: false,
  }),
}));

vi.mock('../api/client', () => {
  const ApiError = class extends Error {
    status: number; body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message); this.name = 'ApiError'; this.status = status; this.body = body;
    }
    get isUnauthorized(): boolean { return this.status === 401; }
  };
  return {
    listAgentSessions: vi.fn(async () => {
      if (apiMockState.listError) throw apiMockState.listError;
      return { sessions: apiMockState.sessions };
    }),
    getAgentConversation: vi.fn(async () => apiMockState.conversation),
    ApiError,
  };

  it('shows tool names and argument keys in collapsed rows and expands/collapses all rows', async () => {
    apiMockState.conversation = {
      session: plannerSession,
      entries: [
        {
          id: 'tc1',
          session_id: 'planner-1',
          role: 'assistant',
          kind: 'tool_call',
          content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'G3', reason: 'ready' }) } }] }),
          timestamp: '2025-06-01T08:06:00Z',
        },
        {
          id: 'tr1',
          session_id: 'planner-1',
          role: 'tool',
          kind: 'tool_result',
          tool: 'activate_card',
          content: JSON.stringify({ ok: true, summary: 'activated G3' }),
          timestamp: '2025-06-01T08:06:01Z',
        },
      ],
    };
    const router = makeRouter();
    await router.push('/agents/planner-1');
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(AgentConversationView, {
      props: { sessionId: 'planner-1' },
      global: { plugins: [router, pinia] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('🔧 activate_card(cardId, reason)');
    expect(wrapper.text()).toContain('📤 activate_card → ok (activated G3)');
    expect(wrapper.find('.tool-call .tool-chip-body').exists()).toBe(false);

    await wrapper.findAll('.conv-tb-btn')[0].trigger('click');
    await flushPromises();
    expect(wrapper.find('.tool-call .tool-chip-body').exists()).toBe(true);
    expect(wrapper.find('.tool-result .tool-chip-body').exists()).toBe(true);

    await wrapper.findAll('.conv-tb-btn')[1].trigger('click');
    await flushPromises();
    expect(wrapper.find('.tool-call .tool-chip-body').exists()).toBe(false);
    expect(wrapper.find('.tool-result .tool-chip-body').exists()).toBe(false);
  });

});

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
const executorSession = makeSession({ id: 'executor-1', role: 'executor', status: 'failed', model: 'deepseek-v4-pro' });
const allSessions = [plannerSession, executorSession];

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/agents', name: 'agents', component: AgentsView },
      { path: '/agents/:id', name: 'agent-detail', component: AgentsView },
      { path: '/cards/:id', name: 'card-detail', component: { template: '<div>Card</div>' } },
      { path: '/files', name: 'files', component: { template: '<div>Files</div>' } },
      { path: '/debug', name: 'debug', component: { template: '<div>Debug</div>' } },
    ],
  });
}

async function mountAgentsView(opts?: {
  sessions?: AgentSession[];
  initialRoute?: string;
  listError?: Error | null;
}) {
  resetTestState();
  apiMockState.sessions = opts?.sessions ?? [];
  apiMockState.listError = opts?.listError ?? null;
  apiMockState.conversation = {
    session: plannerSession,
    entries: [
      {
        id: 'm1',
        session_id: 'planner-1',
        role: 'assistant',
        kind: 'text',
        content: 'Inspect linked evidence.',
        timestamp: '2025-06-01T08:05:00Z',
        links: [
          { entity_type: 'card', entity_id: 'card-123', label: 'Card 123' },
          { entity_type: 'process', entity_id: 'proc-1', label: 'Process proc-1' },
          { entity_type: 'artifact', entity_id: '.saivage-work/output.txt', label: 'Artifact output' },
        ],
      },
    ],
  };

  const pinia = createPinia();
  setActivePinia(pinia);
  const router = makeRouter();
  await router.push(opts?.initialRoute ?? '/agents');
  await router.isReady();

  const wrapper = mount(AgentsView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return { wrapper, router };
}

describe('AgentsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestState();
    apiMockState.sessions = [];
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('renders sessions grouped by role', async () => {
    const { wrapper } = await mountAgentsView({ sessions: allSessions });
    expect(wrapper.text()).toContain('planner');
    expect(wrapper.text()).toContain('executor');
  });

  it('shows empty state when no sessions exist', async () => {
    const { wrapper } = await mountAgentsView({ sessions: [] });
    expect(wrapper.find('.agents-empty').exists()).toBe(true);
  });

  it('shows unauthorized messaging for 401 responses', async () => {
    const { ApiError } = await import('../api/client');
    const { wrapper } = await mountAgentsView({ listError: new ApiError(401, 'Unauthorized', {}) });
    expect(wrapper.find('.agents-unauthorized').exists()).toBe(true);
    expect(wrapper.text()).toContain('valid API token');
  });

  it('shows stale messaging when the agents store is stale', async () => {
    const { wrapper } = await mountAgentsView({ sessions: allSessions });
    const store = useAgentStore();
    store.lastFetchedAt = '2025-06-01T00:00:00Z' as any;
    await flushPromises();
    expect(wrapper.find('.agents-stale').exists()).toBe(true);
    expect(wrapper.text()).toContain('stale');
  });

  it('opens detail view when a session card is clicked', async () => {
    const { wrapper } = await mountAgentsView({ sessions: allSessions });
    await wrapper.find('.session-card').trigger('click');
    await flushPromises();
    expect(wrapper.find('.detail-header-bar').exists()).toBe(true);
  });

  it('agent conversation links navigate to supported entities', async () => {
    const { router } = await mountAgentsView({ sessions: allSessions, initialRoute: '/agents/planner-1' });
    const pushSpy = vi.spyOn(router, 'push');

    const wrapper = mount(AgentConversationView, {
      props: { sessionId: 'planner-1' },
      global: { plugins: [router, createPinia()] },
    });
    await flushPromises();

    const links = wrapper.findAll('.msg-link');
    await links[0].trigger('click');
    await links[1].trigger('click');
    await links[2].trigger('click');

    expect(pushSpy).toHaveBeenCalledWith({ name: 'card-detail', params: { id: 'card-123' } });
    expect(pushSpy).toHaveBeenCalledWith({ name: 'debug', query: { tab: 'processes', process: 'proc-1' } });
    expect(pushSpy).toHaveBeenCalledWith({ name: 'files', query: { path: '.saivage-work/output.txt' } });
  });

  it('shows tool names and argument keys in collapsed rows and expands/collapses all rows', async () => {
    apiMockState.conversation = {
      session: plannerSession,
      entries: [
        {
          id: 'tc1',
          session_id: 'planner-1',
          role: 'assistant',
          kind: 'tool_call',
          content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'G3', reason: 'ready' }) } }] }),
          timestamp: '2025-06-01T08:06:00Z',
        },
        {
          id: 'tr1',
          session_id: 'planner-1',
          role: 'tool',
          kind: 'tool_result',
          tool: 'activate_card',
          content: JSON.stringify({ ok: true, summary: 'activated G3' }),
          timestamp: '2025-06-01T08:06:01Z',
        },
      ],
    };
    const router = makeRouter();
    await router.push('/agents/planner-1');
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(AgentConversationView, {
      props: { sessionId: 'planner-1' },
      global: { plugins: [router, pinia] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('activate_card');
    expect(wrapper.text()).toContain('card G3');
    expect(wrapper.text()).toContain('activated G3');
    expect(wrapper.find('.tool-call .tool-chip-body').exists()).toBe(false);

    await wrapper.findAll('.conv-tb-btn')[0].trigger('click');
    await flushPromises();
    expect(wrapper.find('.tool-call .tool-chip-body').exists()).toBe(true);
    expect(wrapper.find('.tool-result .tool-chip-body').exists()).toBe(true);

    await wrapper.findAll('.conv-tb-btn')[1].trigger('click');
    await flushPromises();
    expect(wrapper.find('.tool-call .tool-chip-body').exists()).toBe(false);
    expect(wrapper.find('.tool-result .tool-chip-body').exists()).toBe(false);
  });

  it('toolbar exposes a raw LLM exchange toggle that mounts and unmounts the panel', async () => {
    apiMockState.conversation = { session: plannerSession, entries: [] };
    const router = makeRouter();
    await router.push('/agents/planner-1');
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(AgentConversationView, {
      props: { sessionId: 'planner-1' },
      global: { plugins: [router, pinia] },
    });
    await flushPromises();

    const toggleBtn = wrapper.findAll('.conv-tb-btn').find((b) => b.text().includes('Last raw LLM exchange'));
    expect(toggleBtn).toBeDefined();
    const RawLlmExchangePanel = (await import('../components/agents/RawLlmExchangePanel.vue')).default;
    expect(wrapper.findComponent(RawLlmExchangePanel).exists()).toBe(false);

    const store = useAgentStore();
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);

    await toggleBtn!.trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(RawLlmExchangePanel).exists()).toBe(true);
    const reToggle = wrapper.findAll('.conv-tb-btn').find((b) => b.text().includes('Hide raw LLM exchange'));
    expect(reToggle).toBeDefined();

    await reToggle!.trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(RawLlmExchangePanel).exists()).toBe(false);
  });

  it('resets the raw LLM exchange panel when the session id prop changes', async () => {
    apiMockState.conversation = { session: plannerSession, entries: [] };
    const router = makeRouter();
    await router.push('/agents/planner-1');
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(AgentConversationView, {
      props: { sessionId: 'planner-1' },
      global: { plugins: [router, pinia] },
    });
    await flushPromises();

    const store = useAgentStore();
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);

    const toggleBtn = wrapper.findAll('.conv-tb-btn').find((b) => b.text().includes('Last raw LLM exchange'));
    await toggleBtn!.trigger('click');
    await flushPromises();
    const RawLlmExchangePanel = (await import('../components/agents/RawLlmExchangePanel.vue')).default;
    expect(wrapper.findComponent(RawLlmExchangePanel).exists()).toBe(true);

    await wrapper.setProps({ sessionId: 'executor-1' } as any);
    await flushPromises();
    expect(wrapper.findComponent(RawLlmExchangePanel).exists()).toBe(false);
  });

});
