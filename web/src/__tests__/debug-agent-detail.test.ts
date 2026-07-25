import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DebugAgentDetail from '../components/agents/DebugAgentDetail.vue';
import source from '../components/agents/DebugAgentDetail.vue?raw';
import { useAgentStore } from '../stores/agents';
import { ApiError } from '../api/client';

const api = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
}));
const live = vi.hoisted(() => ({ openConversation: vi.fn(), openLlmExchange: vi.fn() }));
vi.mock('../stores/liveSync', () => ({ useLiveSyncStore: () => live }));
vi.mock('../api/client', () => ({
  getAgentSession: api.getAgentSession,
  getAgentConversation: api.getAgentConversation,
  getAgentLlmExchange: api.getAgentLlmExchange,
  listAgentSessions: vi.fn(),
  ApiError: class ApiError extends Error {
    body: Record<string, unknown>;
    constructor(
      public status: number,
      message: string,
      body: Record<string, unknown> = {},
    ) {
      super(message);
      this.body = body;
    }
    get isUnauthorized() {
      return this.status === 401;
    }
    get isNotFound() {
      return this.status === 404;
    }
  },
}));

describe('DebugAgentDetail keyed lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    api.getAgentSession.mockResolvedValue({
      session: {
        id: 'agent:executor:project',
        agent_name: 'executor',
        session_scope: 'card',
        card_id: 'project',
        started_at: '2026-01-01T00:00:00Z',
      },
    });
    api.getAgentConversation.mockResolvedValue({
      session_id: 'agent:executor:project',
      entries: [],
      cursor: 'empty',
    });
    api.getAgentLlmExchange.mockRejectedValue(
      new ApiError(404, 'missing', { error: 'No LLM exchange recorded for this session yet.' }),
    );
  });

  it('claims, subscribes, then fetches and unregisters before token clear', async () => {
    const store = useAgentStore();
    const order: string[] = [];
    const begin = store.beginConversationSelection;
    const fetch = store.refetchConversation;
    const clear = store.clearConversationSelection;
    vi.spyOn(store, 'beginConversationSelection').mockImplementation((id) => {
      order.push('begin');
      return begin(id);
    });
    vi.spyOn(store, 'refetchConversation').mockImplementation((token) => {
      order.push('fetch');
      return fetch(token);
    });
    vi.spyOn(store, 'clearConversationSelection').mockImplementation((token) => {
      order.push('clear');
      clear(token);
    });
    const unregister = vi.fn(() => order.push('unregister'));
    live.openConversation.mockImplementation((_id, callback) => {
      order.push('subscribe');
      void callback(null);
      return unregister;
    });

    const wrapper = mount(DebugAgentDetail, {
      props: { sessionId: 'agent:executor:project', kind: 'conversation' },
      global: { stubs: { ConversationTimeline: true, ViewState: true, StatusBanner: true } },
    });
    await flushPromises();
    expect(order.slice(0, 3)).toEqual(['begin', 'subscribe', 'fetch']);
    expect(live.openConversation).toHaveBeenCalledWith(
      'agent:executor:project',
      expect.any(Function),
    );

    const callback = live.openConversation.mock.calls[0][1] as () => Promise<void>;
    await callback();
    expect(api.getAgentConversation).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    expect(order.slice(-2)).toEqual(['unregister', 'clear']);
    expect(store.selectedConversationSessionId).toBeNull();
  });

  it('owns exchange selection independently and renders accepted empty', async () => {
    const store = useAgentStore();
    const clear = vi.spyOn(store, 'clearLlmExchange');
    live.openLlmExchange.mockImplementation((_id, callback) => {
      void callback(null);
      return vi.fn();
    });
    const wrapper = mount(DebugAgentDetail, {
      props: { sessionId: 'agent:executor:project', kind: 'llmExchange' },
      global: { stubs: { CodeBlock: true, ViewState: false, StatusBanner: true } },
    });
    await flushPromises();
    expect(live.openConversation).not.toHaveBeenCalled();
    expect(live.openLlmExchange).toHaveBeenCalledWith(
      'agent:executor:project',
      expect.any(Function),
    );
    expect(api.getAgentLlmExchange).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('No LLM exchange recorded');
    wrapper.unmount();
    expect(clear).toHaveBeenCalledOnce();
    expect(store.llmExchangeSessionId).toBeNull();
  });

  it('contains no prop/list synchronization watcher', () => {
    expect(source).not.toContain('watch(');
    expect(source).not.toContain('fetchSessions');
  });
});
