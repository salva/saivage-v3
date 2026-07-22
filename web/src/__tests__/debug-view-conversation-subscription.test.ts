import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import { useAgentStore } from '../stores/agents';
import { useDebugStore } from '../stores/debug';
import type { AgentConversationResponse, AgentSession } from '../api/types';
import { AgentSessionSummarySchema, type ConversationSessionId } from '../api/contracts';

const api = vi.hoisted(() => ({
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
  listAgentSessions: vi.fn(),
}));
const live = vi.hoisted(() => ({
  registerResource: vi.fn(() => vi.fn()),
  openConversation: vi.fn(),
  unregisters: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock('../stores/liveSync', () => ({ useLiveSyncStore: () => live }));
vi.mock('../api/client', () => ({
  getDebugErrors: vi.fn().mockResolvedValue({ errors: [], total: 0 }),
  getNewestEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
  getDoctor: vi.fn().mockResolvedValue({ status: 'ok', checks: [], issues: [] }),
  listProcesses: vi.fn().mockResolvedValue({ processes: [] }),
  getMcpTools: vi.fn().mockResolvedValue({ tools: [], stats: {}, serverDetails: [] }),
  getAgentConversation: api.getAgentConversation,
  getAgentLlmExchange: api.getAgentLlmExchange,
  listAgentSessions: api.listAgentSessions,
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
    get isUnauthorized() { return this.status === 401; }
    get isNotFound() { return this.status === 404; }
  },
}));

const SESSION_A = 'agent:planner:project' as const;
const SESSION_B = 'agent:reviewer:project' as const;
function session(id: ConversationSessionId): AgentSession {
  const agent_name = id.startsWith('agent:reviewer:') ? 'reviewer' : 'planner';
  return AgentSessionSummarySchema.parse({ id, agent_name, session_scope: 'card', status: 'active', card_id: 'project', started_at: '2026-01-01T00:00:00.000Z', model: 'test' });
}
function conversation(id: ConversationSessionId): AgentConversationResponse {
  return { session: session(id), entries: [], activity_status: { status: 'active', pending_calls: [] } };
}

async function mountDebug() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/debug', name: 'debug', component: DebugView },
      { path: '/other', name: 'other', component: { template: '<div>Other</div>' } },
      { path: '/files', name: 'files', component: { template: '<div>Files</div>' } },
    ],
  });
  await router.push('/debug?tab=agents');
  await router.isReady();
  const wrapper = mount(DebugView, { global: { plugins: [pinia, router], stubs: { CodeBlock: true, ConversationTimeline: true, StatusBanner: true, StatusBadge: true } } });
  await flushPromises();
  return { wrapper, router, store: useAgentStore() };
}

describe('DebugView canonical agent selection and keyed detail lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    live.unregisters = [];
    live.openConversation.mockImplementation(() => {
      const unregister = vi.fn();
      live.unregisters.push(unregister);
      return unregister;
    });
    api.getAgentConversation.mockImplementation(async (id: ConversationSessionId) => conversation(id));
    api.getAgentLlmExchange.mockImplementation(async (sessionId: ConversationSessionId) => ({ sessionId, exchange: null }));
    api.listAgentSessions.mockResolvedValue({ sessions: [] });
  });

  it('mounts no detail before late bootstrap, then derives first without a list fetch', async () => {
    const { wrapper, store } = await mountDebug();
    expect(live.openConversation).not.toHaveBeenCalled();
    expect(api.getAgentConversation).not.toHaveBeenCalled();
    expect(api.listAgentSessions).not.toHaveBeenCalled();

    store.sessions = [session(SESSION_B), session(SESSION_A)];
    store.sessionsLoaded = true;
    await flushPromises();

    expect(live.openConversation).toHaveBeenCalledTimes(1);
    expect(live.openConversation).toHaveBeenCalledWith(SESSION_B, expect.any(Function));
    expect(api.getAgentConversation).toHaveBeenCalledWith(SESSION_B, expect.any(AbortSignal));
    expect(wrapper.find(`[data-session-id="${SESSION_B}"]`).exists()).toBe(true);
    expect(api.listAgentSessions).not.toHaveBeenCalled();
  });

  it('keeps timeline and process live-sync registrations on their focused refetch functions', async () => {
    const { wrapper } = await mountDebug();
    const debugStore = useDebugStore();
    expect(live.registerResource).toHaveBeenCalledWith({ resource: 'timeline', scope: 'active', requestOwnership: 'sync-client', refetch: debugStore.refetchTimeline });
    expect(live.registerResource).toHaveBeenCalledWith({ resource: 'processes', scope: 'active', requestOwnership: 'sync-client', refetch: debugStore.refetchProcesses });
    wrapper.unmount();
  });

  it('preserves explicit intent across reorder, fallback, reappearance, kind, empty, tab, and route changes', async () => {
    const { wrapper, router, store } = await mountDebug();
    store.sessions = [session(SESSION_A), session(SESSION_B)];
    store.sessionsLoaded = true;
    await flushPromises();

    const sessionB = wrapper.findAll('.agent-debug-session').find((button) => button.text().includes(SESSION_B))!;
    await sessionB.trigger('click');
    await flushPromises();
    expect(wrapper.find(`[data-session-id="${SESSION_B}"]`).exists()).toBe(true);

    store.sessions = [session(SESSION_B), session(SESSION_A)];
    await flushPromises();
    expect(wrapper.find(`[data-session-id="${SESSION_B}"]`).exists()).toBe(true);

    store.sessions = [session(SESSION_A)];
    await flushPromises();
    expect(wrapper.find(`[data-session-id="${SESSION_A}"]`).exists()).toBe(true);

    store.sessions = [session(SESSION_A), session(SESSION_B)];
    await flushPromises();
    expect(wrapper.find(`[data-session-id="${SESSION_B}"]`).exists()).toBe(true);

    const raw = wrapper.findAll('.debug-tab-button').find((button) => button.text() === 'Raw LLM Exchange')!;
    const conversationUnregister = live.unregisters.at(-1)!;
    await raw.trigger('click');
    await flushPromises();
    expect(conversationUnregister).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-detail-kind="llmExchange"]').exists()).toBe(true);
    expect(api.getAgentLlmExchange).toHaveBeenLastCalledWith(SESSION_B, expect.any(AbortSignal));

    store.sessions = [];
    await flushPromises();
    expect(wrapper.find('[data-session-id]').exists()).toBe(false);
    expect(wrapper.text()).toContain('No agent sessions');

    store.sessions = [session(SESSION_A)];
    await flushPromises();
    expect(wrapper.find(`[data-session-id="${SESSION_A}"]`).exists()).toBe(true);

    const state = wrapper.findAll('.debug-tab-button').find((button) => button.text() === 'State')!;
    await state.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-session-id]').exists()).toBe(false);

    const agents = wrapper.findAll('.debug-tab-button').find((button) => button.text() === 'Agents')!;
    await agents.trigger('click');
    await flushPromises();
    expect(wrapper.find(`[data-session-id="${SESSION_A}"]`).exists()).toBe(true);
    await router.push('/other');
    await flushPromises();
    expect(wrapper.find('[data-session-id]').exists()).toBe(false);
  });
});
