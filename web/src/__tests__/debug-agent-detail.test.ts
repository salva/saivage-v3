import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DebugAgentDetail from '../components/agents/DebugAgentDetail.vue';
import source from '../components/agents/DebugAgentDetail.vue?raw';
import { useAgentStore } from '../stores/agents';

const api = vi.hoisted(() => ({ getAgentConversation: vi.fn(), getAgentLlmExchange: vi.fn() }));
const live = vi.hoisted(() => ({ openConversation: vi.fn() }));
vi.mock('../stores/liveSync', () => ({ useLiveSyncStore: () => live }));
vi.mock('../api/client', () => ({
  getAgentConversation: api.getAgentConversation,
  getAgentLlmExchange: api.getAgentLlmExchange,
  listAgentSessions: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
    get isUnauthorized() { return this.status === 401; }
    get isNotFound() { return this.status === 404; }
  },
}));

describe('DebugAgentDetail keyed lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    api.getAgentConversation.mockResolvedValue({
      session: { id: 'executor:project', role: 'executor', status: 'active', goal_card_id: 'project', card_id: 'project', started_at: '2026-01-01T00:00:00Z', model: 'test' },
      entries: [],
      activity_status: { status: 'active', pending_calls: [] },
    });
    api.getAgentLlmExchange.mockResolvedValue({ sessionId: 'executor:project', exchange: null });
  });

  it('claims, subscribes, then fetches and unregisters before token clear', async () => {
    const store = useAgentStore();
    const order: string[] = [];
    const begin = store.beginConversationSelection;
    const fetch = store.fetchConversation;
    const clear = store.clearConversationSelection;
    vi.spyOn(store, 'beginConversationSelection').mockImplementation((id) => { order.push('begin'); return begin(id); });
    vi.spyOn(store, 'fetchConversation').mockImplementation((token) => { order.push('fetch'); return fetch(token); });
    vi.spyOn(store, 'clearConversationSelection').mockImplementation((token) => { order.push('clear'); clear(token); });
    const unregister = vi.fn(() => order.push('unregister'));
    live.openConversation.mockImplementation(() => { order.push('subscribe'); return unregister; });

    const wrapper = mount(DebugAgentDetail, { props: { sessionId: 'executor:project', kind: 'conversation' }, global: { stubs: { ConversationTimeline: true, ViewState: true, StatusBanner: true } } });
    await flushPromises();
    expect(order.slice(0, 3)).toEqual(['begin', 'subscribe', 'fetch']);
    expect(live.openConversation).toHaveBeenCalledWith('executor:project', expect.any(Function));

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
    const wrapper = mount(DebugAgentDetail, { props: { sessionId: 'executor:project', kind: 'llmExchange' }, global: { stubs: { CodeBlock: true, ViewState: false, StatusBanner: true } } });
    await flushPromises();
    expect(live.openConversation).not.toHaveBeenCalled();
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
