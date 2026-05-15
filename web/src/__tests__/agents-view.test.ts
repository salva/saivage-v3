import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import AgentsView from '../views/AgentsView.vue';
import AgentConversationView from '../components/agents/AgentConversationView.vue';
import type { AgentSession, AgentRole } from '../api/types';

const apiMockState = vi.hoisted(() => ({
  sessions: [] as AgentSession[],
  conversation: {
    session: null as AgentSession | null,
    messages: [] as any[],
  },
}));

let wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();

function resetTestState() {
  wsTypeHandlers = new Map();
}

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
    onReconnect: vi.fn(() => () => {}),
    sendMessage: vi.fn(),
    isConnected: () => true,
    isConnecting: () => false,
    connect: vi.fn(),
    disconnect: vi.fn(),
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
    listAgentSessions: vi.fn(async () => ({ sessions: apiMockState.sessions })),
    getAgentConversation: vi.fn(async () => apiMockState.conversation),
    ApiError,
  };
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
}) {
  resetTestState();
  apiMockState.sessions = opts?.sessions ?? [];
  apiMockState.conversation = {
    session: plannerSession,
    messages: [
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
});
