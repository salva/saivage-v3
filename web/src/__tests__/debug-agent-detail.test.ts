import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DebugAgentDetail from '../components/agents/DebugAgentDetail.vue';
import source from '../components/agents/DebugAgentDetail.vue?raw';
import { useAgentStore } from '../stores/agents';
import { OperatorApiError } from '../api/client';

const api = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
  getAgentConversation: vi.fn(),
  getAgentLlmExchange: vi.fn(),
}));
const live = vi.hoisted(() => ({ openConversation: vi.fn(), openLlmExchange: vi.fn() }));
vi.mock('../stores/sync', () => ({ useSyncStore: () => live }));
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getAgentSession: api.getAgentSession,
  getAgentConversation: api.getAgentConversation,
  getAgentLlmExchange: api.getAgentLlmExchange,
  listAgentSessions: vi.fn(),
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
        status: 'inactive', activity: 'idle',
      },
    });
    api.getAgentConversation.mockResolvedValue({
      session_id: 'agent:executor:project',
      segment_version: 1,
      segment_context: null,
      entries: [],
      cursor: { segment_version: 1, message_id: null },
    });
    api.getAgentLlmExchange.mockRejectedValue(
      new OperatorApiError('agents.llmExchange', 404, { error: 'No LLM exchange recorded for this session yet.' }),
    );
  });

  it('wires acknowledged conversation loading and Reload through the selected conversation', async () => {
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
    await wrapper.get('.sv-fetch-btn').trigger('click');
    await flushPromises();
    expect(api.getAgentConversation).toHaveBeenCalledTimes(2);

    const callback = live.openConversation.mock.calls[0][1] as () => Promise<void>;
    await callback();
    expect(api.getAgentConversation).toHaveBeenCalledTimes(3);
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
  });

  it('renders initial 401 as unavailable and refresh 401 as a warning beside accepted content', async () => {
    const unauthorized = new OperatorApiError('agents.conversation', 401, {
      statusCode: 401,
      error: 'Unauthorized',
    });
    let callback!: (frame: any) => Promise<void>;
    live.openConversation.mockImplementation((_id, value) => {
      callback = value;
      return vi.fn();
    });
    api.getAgentConversation.mockRejectedValueOnce(unauthorized);
    const initial = mount(DebugAgentDetail, {
      props: { sessionId: 'agent:executor:project', kind: 'conversation' },
    });
    await expect(callback(null)).rejects.toBe(unauthorized);
    await flushPromises();
    expect(initial.text()).toContain('Conversation unavailable');
    expect(initial.find('.agent-debug-conversation').exists()).toBe(false);
    initial.unmount();

    api.getAgentConversation
      .mockResolvedValueOnce({
        session_id: 'agent:executor:project',
        segment_version: 1,
        segment_context: null,
        entries: [],
        cursor: { segment_version: 1, message_id: null },
      })
      .mockRejectedValueOnce(unauthorized);
    const loaded = mount(DebugAgentDetail, {
      props: { sessionId: 'agent:executor:project', kind: 'conversation' },
    });
    await callback(null);
    await flushPromises();
    await expect(callback({
      t: 'invalidate',
      resource: 'conversation',
      id: 'agent:executor:project',
      segment_version: 1,
      visible_message_id: 'next',
    })).rejects.toBe(unauthorized);
    await flushPromises();
    expect(loaded.text()).toContain('Unauthorized');
    expect(loaded.text()).not.toContain('Conversation unavailable');
    expect(loaded.find('.agent-debug-conversation').exists()).toBe(true);
    loaded.unmount();
  });

  it('contains no prop/list synchronization watcher', () => {
    expect(source).not.toContain('watch(');
    expect(source).not.toContain('fetchSessions');
    expect(source).toContain("props.kind === 'conversation' ? useSelectedConversation(props.sessionId) : null");
    expect(source).not.toContain('beginConversationSelection');
    expect(source).not.toContain('openConversation(');
  });
});
