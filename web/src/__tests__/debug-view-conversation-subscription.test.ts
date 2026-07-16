import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import DebugView from '../views/DebugView.vue';
import { useAgentStore } from '../stores/agents';
import type { AgentConversationResponse, AgentSession } from '../api/types';

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
  getDebugTimeline: vi.fn().mockResolvedValue({ events: [], total: 0 }),
  getDoctor: vi.fn().mockResolvedValue({ status: 'ok', checks: [], issues: [] }),
  getDebugSupervision: vi.fn().mockResolvedValue({ reviews: [], stats: null }),
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

function session(id: string): AgentSession {
  return { id, role: 'executor', status: 'active', goal_card_id: 'project', card_id: 'project', started_at: '2026-01-01T00:00:00.000Z', completed_at: null, model: 'test' };
}
function conversation(id: string): AgentConversationResponse {
  return { session: session(id), entries: [], activity_status: { status: 'idle', pending_calls: [], updated_at: '2026-01-01T00:00:00.000Z' } };
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
    api.getAgentConversation.mockImplementation(async (id: string) => conversation(id));
    api.getAgentLlmExchange.mockResolvedValue({ exchange: null });
    api.listAgentSessions.mockResolvedValue({ sessions: [] });
  });

  it('mounts no detail before late bootstrap, then derives first without a list fetch', async () => {
    const { wrapper, store } = await mountDebug();
    expect(live.openConversation).not.toHaveBeenCalled();
    expect(api.getAgentConversation).not.toHaveBeenCalled();
    expect(api.listAgentSessions).not.toHaveBeenCalled();

    store.sessions = [session('session-b'), session('session-a')];
    store.sessionsLoaded = true;
    await flushPromises();

    expect(live.openConversation).toHaveBeenCalledTimes(1);
    expect(live.openConversation).toHaveBeenCalledWith('session-b', expect.any(Function));
    expect(api.getAgentConversation).toHaveBeenCalledWith('session-b', expect.any(AbortSignal));
    expect(wrapper.find('[data-session-id="session-b"]').exists()).toBe(true);
    expect(api.listAgentSessions).not.toHaveBeenCalled();
  });

  it('preserves explicit intent across reorder, fallback, reappearance, kind, empty, tab, and route changes', async () => {
    const { wrapper, router, store } = await mountDebug();
    store.sessions = [session('session-a'), session('session-b')];
    store.sessionsLoaded = true;
    await flushPromises();

    const sessionB = wrapper.findAll('.agent-debug-session').find((button) => button.text().includes('session-b'))!;
    await sessionB.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-session-id="session-b"]').exists()).toBe(true);

    store.sessions = [session('session-b'), session('session-a')];
    await flushPromises();
    expect(wrapper.find('[data-session-id="session-b"]').exists()).toBe(true);

    store.sessions = [session('session-a')];
    await flushPromises();
    expect(wrapper.find('[data-session-id="session-a"]').exists()).toBe(true);

    store.sessions = [session('session-a'), session('session-b')];
    await flushPromises();
    expect(wrapper.find('[data-session-id="session-b"]').exists()).toBe(true);

    const raw = wrapper.findAll('.debug-tab-button').find((button) => button.text() === 'Raw LLM Exchange')!;
    const conversationUnregister = live.unregisters.at(-1)!;
    await raw.trigger('click');
    await flushPromises();
    expect(conversationUnregister).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-detail-kind="llmExchange"]').exists()).toBe(true);
    expect(api.getAgentLlmExchange).toHaveBeenLastCalledWith('session-b', expect.any(AbortSignal));

    store.sessions = [];
    await flushPromises();
    expect(wrapper.find('[data-session-id]').exists()).toBe(false);
    expect(wrapper.text()).toContain('No agent sessions');

    store.sessions = [session('session-a')];
    await flushPromises();
    expect(wrapper.find('[data-session-id="session-a"]').exists()).toBe(true);

    const state = wrapper.findAll('.debug-tab-button').find((button) => button.text() === 'State')!;
    await state.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-session-id]').exists()).toBe(false);

    const agents = wrapper.findAll('.debug-tab-button').find((button) => button.text() === 'Agents')!;
    await agents.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-session-id="session-a"]').exists()).toBe(true);
    await router.push('/other');
    await flushPromises();
    expect(wrapper.find('[data-session-id]').exists()).toBe(false);
  });
});
