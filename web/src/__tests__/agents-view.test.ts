import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import AgentsView from '../views/AgentsView.vue';
import agentsViewSource from '../views/AgentsView.vue?raw';
import AgentConversationView from '../components/agents/AgentConversationView.vue';
import { useAgentStore } from '../stores/agents';
import type { AgentSession } from '../api/types';
import { AgentSessionSummarySchema } from '../api/contracts';
const apiMockState = vi.hoisted(() => ({
  sessions: [] as AgentSession[],
  conversation: {
    session: null as AgentSession | null,
    entries: [] as any[],
  },
  listError: null as Error | null,
}));
const liveSyncMock = vi.hoisted(() => ({ openConversation: vi.fn(() => vi.fn()) }));

function resetTestState() {
  apiMockState.listError = null;
}

vi.mock('../stores/liveSync', () => ({
  useLiveSyncStore: () => ({
    openConversation: liveSyncMock.openConversation,
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
});

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  const agentName = overrides.agent_name ?? 'planner';
  const sessionScope = overrides.session_scope ?? (agentName === 'analyst' ? 'global' : 'card');
  const id = overrides.id ?? (sessionScope === 'global' ? `agent:${agentName}:global` : `agent:${agentName}:project`);
  const cardId = sessionScope === 'global' ? null : id.slice(id.lastIndexOf(':') + 1);
  return AgentSessionSummarySchema.parse({
    id,
    agent_name: agentName,
    session_scope: sessionScope,
    card_id: cardId,
    status: 'active' as const,
    started_at: '2025-06-01T08:00:00Z',
    model: 'claude-sonnet-4',
    ...overrides,
  });
}

const plannerSession = makeSession({ id: 'agent:planner:project', agent_name: 'planner', status: 'active' });
const executorSession = makeSession({ id: 'agent:executor:project', agent_name: 'executor', status: 'inactive', model: 'deepseek-v4-pro' });
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
        session_id: 'agent:planner:project',
        role: 'assistant',
          kind: 'text',
          content: 'Inspect linked evidence.',
          round_id: 'r-assistant-00000000000000000000000000000001',
          message_index: 0,
          block_index: 0,
        timestamp: '2025-06-01T08:05:00Z',
        links: [
          { entity_type: 'card', entity_id: '11111111-1111-4111-8111-111111111111', label: 'Card title' },
          { entity_type: 'process', entity_id: 'proc-1', label: 'Process proc-1' },
          { entity_type: 'artifact', entity_id: '.saivage/work/output.txt', label: 'Artifact output' },
        ],
      },
    ],
  };

  const pinia = createPinia();
  setActivePinia(pinia);
  await useAgentStore().fetchSessions().catch(() => {});
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

  it('exposes a route-owned root and route-body content for browser smoke assertions', () => {
    expect(agentsViewSource).toContain('data-testid="route-agents"');
    expect(agentsViewSource).toContain('list-label="Agent sessions"');
    expect(agentsViewSource).toContain('class="agents-content"');
  });

  it('renders sessions grouped by agent', async () => {
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

  it.each(['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'])('rejects invalid direct route %s without detail, API, selection, or live sync work', async (id) => {
    const api = await import('../api/client');
    const conversation = vi.mocked(api.getAgentConversation);
    conversation.mockClear();
    liveSyncMock.openConversation.mockClear();
    const { wrapper, router } = await mountAgentsView({ sessions: allSessions, initialRoute: `/agents/${encodeURIComponent(id)}` });
    expect(router.currentRoute.value.params.id).toBe(id);
    expect(wrapper.text()).toContain('Invalid agent session');
    expect(wrapper.findComponent(AgentConversationView).exists()).toBe(false);
    expect(useAgentStore().selectedConversationSessionId).toBeNull();
    expect(conversation).not.toHaveBeenCalled();
    expect(liveSyncMock.openConversation).not.toHaveBeenCalled();
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
    const { router } = await mountAgentsView({ sessions: allSessions, initialRoute: '/agents/agent:planner:project' });
    const pushSpy = vi.spyOn(router, 'push');

    const wrapper = mount(AgentConversationView, {
      props: { sessionId: 'agent:planner:project' },
      global: { plugins: [router, createPinia()] },
    });
    await flushPromises();

    const links = wrapper.findAll('.msg-link');
    await links[0].trigger('click');
    await links[1].trigger('click');
    await links[2].trigger('click');

    expect(pushSpy).toHaveBeenCalledWith({ name: 'card-detail', params: { id: '11111111-1111-4111-8111-111111111111' } });
    expect(pushSpy).toHaveBeenCalledWith({ name: 'debug', query: { tab: 'processes', process: 'proc-1' } });
    expect(pushSpy).toHaveBeenCalledWith({ name: 'files', query: { path: '.saivage/work/output.txt' } });
  });

  it('shows tool names and argument keys in collapsed rows and expands/collapses all rows', async () => {
    apiMockState.conversation = {
      session: plannerSession,
      entries: [
        {
          id: 'tc1',
          session_id: 'agent:planner:project',
          role: 'assistant',
          kind: 'tool_call',
          tool_call_id: 'tc1',
          content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ card_id: 'card-a' }) } }] }),
          round_id: 'r-assistant-00000000000000000000000000000001',
          message_index: 0,
          block_index: 0,
          timestamp: '2025-06-01T08:06:00Z',
        },
        {
          id: 'tr1',
          session_id: 'agent:planner:project',
          role: 'tool',
          kind: 'tool_result',
          tool: 'activate_card',
          tool_call_id: 'tc1',
          content: JSON.stringify({ success: true, data: { card_id: 'card-a', outcome: 'done', summary: 'activated G3', result: { kind: 'workflow-result', terminal: 'DONE', agent_name: 'executor', node_id: 'execute', outcome: 'done', summary: 'activated G3', records: [] } } }),
          round_id: 'r-assistant-00000000000000000000000000000001',
          message_index: 1,
          block_index: 0,
          timestamp: '2025-06-01T08:06:01Z',
        },
      ],
    };
    const router = makeRouter();
    await router.push('/agents/agent:planner:project');
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(AgentConversationView, {
      props: { sessionId: 'agent:planner:project' },
      global: { plugins: [router, pinia] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('Activate');
    expect(wrapper.text()).toContain('card card-a');
    expect(wrapper.text()).toContain('done');
    expect(wrapper.text()).not.toContain('activated G3');
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
    await router.push('/agents/agent:planner:project');
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(AgentConversationView, {
      props: { sessionId: 'agent:planner:project' },
      global: { plugins: [router, pinia] },
    });
    await flushPromises();

    const toggleBtn = wrapper.findAll('.conv-tb-btn').find((b) => b.text().includes('Raw exchange'));
    expect(toggleBtn).toBeDefined();
    const RawLlmExchangePanel = (await import('../components/agents/RawLlmExchangePanel.vue')).default;
    expect(wrapper.findComponent(RawLlmExchangePanel).exists()).toBe(false);

    const store = useAgentStore();
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);

    await toggleBtn!.trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(RawLlmExchangePanel).exists()).toBe(true);
    const reToggle = wrapper.findAll('.conv-tb-btn').find((b) => b.text().includes('Hide raw exchange'));
    expect(reToggle).toBeDefined();

    await reToggle!.trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(RawLlmExchangePanel).exists()).toBe(false);
  });

});
