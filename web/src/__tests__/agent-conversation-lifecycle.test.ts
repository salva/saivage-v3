import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AgentConversationView from '../components/agents/AgentConversationView.vue';
import AgentsView from '../views/AgentsView.vue';
import agentConversationSource from '../components/agents/AgentConversationView.vue?raw';
import agentsViewSource from '../views/AgentsView.vue?raw';
import rawPanelSource from '../components/agents/RawLlmExchangePanel.vue?raw';
import { useAgentStore } from '../stores/agents';

const lifecycle = vi.hoisted(() => ({
  events: [] as string[],
  callbacks: new Map<string, () => Promise<void>>(),
}));

vi.mock('../stores/liveSync', () => ({
  useLiveSyncStore: () => ({
    openConversation: (sessionId: string, callback: () => Promise<void>) => {
      lifecycle.events.push(`subscribe:${sessionId}`);
      lifecycle.callbacks.set(sessionId, callback);
      return () => lifecycle.events.push(`unsubscribe:${sessionId}`);
    },
  }),
}));

vi.mock('../api/client', () => ({
  listAgentSessions: vi.fn(async () => ({ sessions: [makeSession('s1'), makeSession('s2')] })),
  getAgentConversation: vi.fn(async (sessionId: string) => {
    lifecycle.events.push(`fetch:${sessionId}`);
    return { session: makeSession(sessionId), entries: [], activity_status: { status: 'idle', pending_calls: [], updated_at: '2026-01-01T00:00:00.000Z' } };
  }),
  getAgentLlmExchange: vi.fn(),
  ApiError: class extends Error {
    get isUnauthorized() { return false; }
    get isNotFound() { return false; }
  },
}));

function makeSession(id: string) {
  return { id, role: 'planner' as const, status: 'active' as const, started_at: '2026-01-01T00:00:00.000Z' };
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/agents', name: 'agents', component: AgentsView },
      { path: '/agents/:id', name: 'agent-detail', component: AgentsView },
      { path: '/cards/:id', name: 'card-detail', component: { template: '<div />' } },
    ],
  });
}

describe('non-Debug keyed agent conversation lifecycle', () => {
  beforeEach(() => {
    lifecycle.events.length = 0;
    lifecycle.callbacks.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('has keyed children and no prop synchronization watchers or eager exchange fetch', () => {
    expect(agentsViewSource).toContain(':key="selectedSessionId"');
    expect(agentConversationSource).toContain(':key="props.sessionId"');
    expect(agentConversationSource).not.toContain('watch(');
    expect(rawPanelSource).not.toContain('watch(');
    expect(rawPanelSource).not.toContain('maybeFetch');
  });

  it('claims, subscribes, then fetches once and unregisters before token-guarded clear', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    const begin = vi.spyOn(store, 'beginConversationSelection');
    const refetch = vi.spyOn(store, 'refetchConversation');
    const originalClear = store.clearConversationSelection;
    const clear = vi.spyOn(store, 'clearConversationSelection').mockImplementation((token) => {
      lifecycle.events.push('clear:s1');
      originalClear(token);
    });
    const wrapper = mount(AgentConversationView, { props: { sessionId: 's1' }, global: { plugins: [pinia] } });
    await flushPromises();

    const token = begin.mock.results[0].value;
    expect(lifecycle.events.slice(0, 2)).toEqual(['subscribe:s1', 'fetch:s1']);
    expect(store.selectedConversationSessionId).toBe('s1');
    await lifecycle.callbacks.get('s1')?.();
    expect(refetch).toHaveBeenCalledWith(token);

    wrapper.unmount();
    expect(lifecycle.events.slice(-2)).toEqual(['unsubscribe:s1', 'clear:s1']);
    expect(clear).toHaveBeenCalledWith(token);
    expect(store.selectedConversationSessionId).toBeNull();
  });

  it('route A to B fully disposes keyed A before keyed B subscribes and fetches', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = makeRouter();
    await router.push('/agents/s1');
    await router.isReady();
    const store = useAgentStore();
    const originalClear = store.clearConversationSelection;
    vi.spyOn(store, 'clearConversationSelection').mockImplementation((token) => {
      lifecycle.events.push(`clear:${store.selectedConversationSessionId}`);
      originalClear(token);
    });
    const wrapper = mount(AgentsView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    lifecycle.events.length = 0;

    await router.push('/agents/s2');
    await flushPromises();
    expect(lifecycle.events).toEqual(['unsubscribe:s1', 'clear:s1', 'subscribe:s2', 'fetch:s2']);
    expect(store.selectedConversationSessionId).toBe('s2');

    await router.push('/agents');
    await flushPromises();
    expect(lifecycle.events.slice(-2)).toEqual(['unsubscribe:s2', 'clear:s2']);
    expect(store.selectedConversationSessionId).toBeNull();
    wrapper.unmount();
  });
});
