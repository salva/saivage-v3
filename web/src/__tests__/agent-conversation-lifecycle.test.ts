import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DURABLE_PRIMARY_CONTENT_POLICY } from '../api/contracts';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { nextTick, type Ref } from 'vue';
import AgentConversationView from '../components/agents/AgentConversationView.vue';
import AgentsView from '../views/AgentsView.vue';
import agentConversationSource from '../components/agents/AgentConversationView.vue?raw';
import agentsViewSource from '../views/AgentsView.vue?raw';
import rawPanelSource from '../components/agents/RawLlmExchangePanel.vue?raw';
import { OperatorApiError } from '../api/client';
import type { AgentConversationEntry, AgentConversationResponse } from '../api/types';
import type { ConversationInvalidation } from '../sync/client';
import { useAgentStore } from '../stores/agents';

const lifecycle = vi.hoisted(() => ({
  events: [] as string[],
  callbacks: new Map<string, (frame: ConversationInvalidation) => Promise<void>>(),
}));
const api = vi.hoisted(() => ({
  getAgentConversation: vi.fn(),
  getAgentSession: vi.fn(),
}));
const live = vi.hoisted(() => ({
  connectionState: null as Ref<'connected' | 'connecting' | 'offline' | 'unauthorized'> | null,
}));

vi.mock('../stores/sync', async () => {
  const { ref } = await import('vue');
  live.connectionState = ref<'connected' | 'connecting' | 'offline' | 'unauthorized'>('connected');
  return {
    useSyncStore: () => ({
      get connectionState() {
        return live.connectionState!.value;
      },
      openAgents: () => () => {},
      openConversation: (sessionId: string, callback: (frame: ConversationInvalidation) => Promise<void>) => {
        lifecycle.events.push(`subscribe:${sessionId}`);
        lifecycle.callbacks.set(sessionId, callback);
        return () => lifecycle.events.push(`unsubscribe:${sessionId}`);
      },
    }),
  };
});

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  listAgentSessions: vi.fn(async () => ({ sessions: [makeSession('agent:planner:project'), makeSession('agent:reviewer:project')] })),
  getAgentConversation: api.getAgentConversation,
  getAgentSession: api.getAgentSession,
  getAgentLlmExchange: vi.fn(),
}));

function makeSession(id: 'agent:planner:project' | 'agent:reviewer:project') {
  return { id, agent_name: id === 'agent:planner:project' ? 'planner' : 'reviewer', session_scope: 'card' as const, card_id: 'project', started_at: '2026-01-01T00:00:00.000Z', status: 'inactive' as const, activity: 'idle' as const, compaction: null };
}

function textEntry(id: string, messageIndex: number): AgentConversationEntry {
  return {
    id,
    session_id: 'agent:planner:project',
    role: 'assistant',
    kind: 'text',
    content: `message ${id}`,
    context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
    round_id: `r-assistant-0000000000000000000000000000000${messageIndex}`,
    message_index: messageIndex,
    block_index: 0,
    timestamp: `2026-01-01T00:00:0${messageIndex}.000Z`,
  } as AgentConversationEntry;
}

function response(
  entries: AgentConversationEntry[],
  messageId: string | null = entries.at(-1)?.id ?? null,
): AgentConversationResponse {
  return {
    session_id: 'agent:planner:project',
    segment_version: 1,
    segment_context: null,
    entries,
    cursor: { segment_version: 1, message_id: messageId },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

let evidenceLookups = 0;
let centerScrolls = 0;
let originalQuerySelector: typeof Element.prototype.querySelector;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

function installViewportModel(): void {
  originalQuerySelector = Element.prototype.querySelector;
  Element.prototype.querySelector = function <E extends Element = Element>(selectors: string): E | null {
    if (selectors.startsWith('[data-entry-id=')) evidenceLookups += 1;
    return originalQuerySelector.call(this, selectors) as E | null;
  };
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions | boolean): void {
    expect(options).toEqual({ block: 'center' });
    centerScrolls += 1;
    const viewport = this.closest('.conv-rounds') as HTMLElement | null;
    if (viewport) viewport.scrollTop = 400;
  };
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return this.classList.contains('conv-rounds') ? 1000 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList.contains('conv-rounds') ? 200 : 0;
    },
  });
}

async function mountConversation(entryId: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(AgentConversationView, {
    props: { sessionId: 'agent:planner:project', entryId },
    global: {
      plugins: [pinia],
      stubs: {
        ContextBlock: {
          props: ['entry'],
          template: '<article :data-entry-id="entry.id" />',
        },
      },
    },
  });
  await nextTick();
  return { wrapper, store: useAgentStore(), callback: lifecycle.callbacks.get('agent:planner:project')! };
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
    live.connectionState!.value = 'connected';
    setActivePinia(createPinia());
    vi.clearAllMocks();
    api.getAgentConversation.mockImplementation(async (sessionId: 'agent:planner:project' | 'agent:reviewer:project') => {
      lifecycle.events.push(`fetch:${sessionId}`);
      return response([]);
    });
    api.getAgentSession.mockImplementation(async (sessionId: 'agent:planner:project' | 'agent:reviewer:project') => ({ session: makeSession(sessionId) }));
    evidenceLookups = 0;
    centerScrolls = 0;
    installViewportModel();
  });

  afterEach(() => {
    Element.prototype.querySelector = originalQuerySelector;
    if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
  });

  it('has keyed children, view-local evidence targeting, and no eager exchange fetch', () => {
    expect(agentsViewSource).toContain(':key="selectedSessionId"');
    expect(agentConversationSource).toContain(':key="props.sessionId"');
    expect(agentConversationSource).toContain('[entries, loading, conversationRefreshing]');
    expect(rawPanelSource).not.toContain('watch(');
    expect(rawPanelSource).not.toContain('maybeFetch');
    expect(agentsViewSource).toContain(':entry-id="selectedEntryId"');
    expect(agentConversationSource).toContain('[data-entry-id=');
  });

  it('presents the gated first transcript as waiting until acknowledgement loads its baseline', async () => {
    live.connectionState!.value = 'offline';
    api.getAgentConversation.mockResolvedValueOnce(response([textEntry('first', 1)]));
    const { wrapper, callback } = await mountConversation('');

    expect(wrapper.text()).toContain('Waiting for conversation');
    expect(wrapper.text()).toContain('Live sync is not connected');
    expect(wrapper.find('.conv-rounds').exists()).toBe(false);
    expect(api.getAgentConversation).not.toHaveBeenCalled();

    live.connectionState!.value = 'connected';
    await nextTick();
    expect(wrapper.text()).toContain('subscription acknowledgement');

    await callback(null);
    await flushPromises();
    expect(wrapper.text()).not.toContain('Waiting for conversation');
    expect(wrapper.find('.conv-rounds').exists()).toBe(true);
    expect(wrapper.find('[data-entry-id="first"]').exists()).toBe(true);
  });

  it('centers initial evidence after render and leaves evidence centering after pinned auto-tail', async () => {
    api.getAgentConversation.mockResolvedValueOnce(response([textEntry('target', 1), textEntry('latest', 2)]));
    const { wrapper, callback } = await mountConversation('target');

    await callback(null);
    await flushPromises();

    const viewport = wrapper.get('.conv-rounds').element as HTMLElement;
    expect(evidenceLookups).toBe(1);
    expect(centerScrolls).toBe(1);
    expect(viewport.scrollTop).toBe(400);
    expect(wrapper.get('[data-entry-id="target"]').classes()).toContain('targeted-conversation-entry');
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');
  });

  it('publishes one missing pass for an accepted result without the target', async () => {
    api.getAgentConversation.mockResolvedValueOnce(response([textEntry('other', 1)]));
    const { wrapper, callback } = await mountConversation('target');

    await callback(null);
    await flushPromises();

    expect(evidenceLookups).toBe(1);
    expect(centerScrolls).toBe(0);
    expect(wrapper.text()).toContain('requested conversation entry was not found');
  });

  it('focuses once for growth, same-length replacement, and each later accepted replacement', async () => {
    api.getAgentConversation
      .mockResolvedValueOnce(response([textEntry('other', 1)]))
      .mockResolvedValueOnce(response([textEntry('target', 2)], 'target'))
      .mockResolvedValueOnce(response([textEntry('target', 3), textEntry('same-length', 4)], 'target-3'))
      .mockResolvedValueOnce(response([textEntry('target', 5), textEntry('repeated', 6)], 'target-4'));
    const { wrapper, callback } = await mountConversation('target');
    await callback(null);
    await flushPromises();
    expect(wrapper.text()).toContain('requested conversation entry was not found');

    evidenceLookups = 0;
    centerScrolls = 0;
    await callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_version: 1, visible_message_id: 'target' });
    await flushPromises();
    expect(evidenceLookups).toBe(1);
    expect(centerScrolls).toBe(1);
    expect((wrapper.get('.conv-rounds').element as HTMLElement).scrollTop).toBe(400);
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');

    await callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_version: 2, visible_message_id: 'target-3' });
    await flushPromises();
    expect(evidenceLookups).toBe(2);
    expect(centerScrolls).toBe(2);

    await callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_version: 3, visible_message_id: 'target-4' });
    await flushPromises();
    expect(evidenceLookups).toBe(3);
    expect(centerScrolls).toBe(3);
  });

  it('retains accepted target state and performs no focus pass when refresh fails', async () => {
    api.getAgentConversation
      .mockResolvedValueOnce(response([textEntry('target', 1)]))
      .mockRejectedValueOnce(new Error('refresh failed'));
    const { wrapper, callback } = await mountConversation('target');
    await callback(null);
    await flushPromises();
    evidenceLookups = 0;
    centerScrolls = 0;

    await expect(callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_version: 1, visible_message_id: 'next' })).rejects.toThrow('refresh failed');
    await flushPromises();

    expect(evidenceLookups).toBe(0);
    expect(centerScrolls).toBe(0);
    expect(wrapper.get('[data-entry-id="target"]').classes()).toContain('targeted-conversation-entry');
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');
  });

  it('shows initial 401 as unavailable but keeps accepted content mounted on refresh 401', async () => {
    const unauthorized = new OperatorApiError('agents.conversation', 401, {
      statusCode: 401,
      error: 'Unauthorized',
    });
    api.getAgentConversation.mockRejectedValueOnce(unauthorized);
    const initial = await mountConversation('target');
    await expect(initial.callback(null)).rejects.toBe(unauthorized);
    await flushPromises();
    expect(initial.wrapper.text()).toContain('Conversation unavailable');
    expect(initial.wrapper.find('.conv-rounds').exists()).toBe(false);
    initial.wrapper.unmount();

    api.getAgentConversation
      .mockResolvedValueOnce(response([textEntry('target', 1)]))
      .mockRejectedValueOnce(unauthorized);
    const loaded = await mountConversation('target');
    await loaded.callback(null);
    await flushPromises();
    expect(loaded.store.currentSession?.id).toBe('agent:planner:project');
    expect(loaded.store.sessionSummaryError).toBeNull();
    expect(loaded.store.sessionSummaryRefreshError).toBeNull();
    await expect(loaded.callback({
      t: 'invalidate',
      resource: 'conversation',
      id: 'agent:planner:project',
      segment_version: 1,
      visible_message_id: 'next',
    })).rejects.toBe(unauthorized);
    await flushPromises();
    expect(loaded.store.conversationError).toBeNull();
    expect(loaded.store.conversationRefreshError).toBe('Unauthorized');
    expect(loaded.wrapper.text()).toContain('Unauthorized');
    expect(loaded.wrapper.text()).not.toContain('Conversation unavailable');
    expect(loaded.wrapper.find('[data-entry-id="target"]').exists()).toBe(true);
    expect(loaded.wrapper.find('.conv-rounds').exists()).toBe(true);
  });

  it('disposes a queued evidence watcher without DOM or focus effects', async () => {
    api.getAgentConversation.mockResolvedValueOnce(response([textEntry('target', 1)]));
    const { wrapper, store, callback } = await mountConversation('target');
    await callback(null);
    await flushPromises();
    evidenceLookups = 0;
    centerScrolls = 0;

    store.entries = [textEntry('target', 2)];
    wrapper.unmount();
    await nextTick();

    expect(evidenceLookups).toBe(0);
    expect(centerScrolls).toBe(0);
  });

  it('retains rows during cursor-conflict recovery and focuses only the settled authoritative replacement', async () => {
    const authoritative = deferred<AgentConversationResponse>();
    api.getAgentConversation
      .mockResolvedValueOnce(response([textEntry('target', 1), textEntry('prior', 2)]))
      .mockRejectedValueOnce(
        new OperatorApiError('agents.conversation', 409, {
          error: 'conversation_segment_changed',
          session_id: 'agent:planner:project',
          requested_segment_version: 1,
          current_segment_version: 2,
        }),
      )
      .mockImplementationOnce(() => authoritative.promise);
    const { wrapper, store, callback } = await mountConversation('target');
    await callback(null);
    await flushPromises();
    evidenceLookups = 0;
    centerScrolls = 0;

    const recovery = callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_version: 1, visible_message_id: 'next' });
    await flushPromises();

    expect(store.entries.map(({ id }) => id)).toEqual(['target', 'prior']);
    expect(store.conversationRefreshing).toBe(true);
    expect(api.getAgentConversation).toHaveBeenLastCalledWith(
      'agent:planner:project',
      expect.any(AbortSignal),
      undefined,
    );
    expect(evidenceLookups).toBe(0);
    expect(centerScrolls).toBe(0);
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');

    authoritative.resolve(response([textEntry('target', 3), textEntry('authoritative', 4)]));
    await recovery;
    await flushPromises();

    expect(evidenceLookups).toBe(1);
    expect(centerScrolls).toBe(1);
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');
    expect(wrapper.find('[data-entry-id="authoritative"]').exists()).toBe(true);
  });

  it('retains mounted rows and reports refresh error when the cursorless conflict retry fails', async () => {
    api.getAgentConversation
      .mockResolvedValueOnce(response([textEntry('target', 1)]))
      .mockRejectedValueOnce(
        new OperatorApiError('agents.conversation', 409, {
          error: 'conversation_segment_changed',
          session_id: 'agent:planner:project',
          requested_segment_version: 1,
          current_segment_version: 2,
        }),
      )
      .mockRejectedValueOnce(new Error('cursorless retry failed'));
    const { wrapper, store, callback } = await mountConversation('target');
    await callback(null);
    await flushPromises();

    await expect(callback({
      t: 'invalidate',
      resource: 'conversation',
      id: 'agent:planner:project',
      segment_version: 1,
      visible_message_id: 'next',
    })).rejects.toThrow('cursorless retry failed');
    await flushPromises();
    expect(api.getAgentConversation).toHaveBeenLastCalledWith(
      'agent:planner:project',
      expect.any(AbortSignal),
      undefined,
    );
    expect(store.entries.map(({ id }) => id)).toEqual(['target']);
    expect(store.conversationRefreshError).toBe('cursorless retry failed');
    expect(wrapper.find('[data-entry-id="target"]').exists()).toBe(true);
  });

  it('route A to B fully disposes keyed A before keyed B subscribes and fetches', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = makeRouter();
    await router.push('/agents/agent:planner:project');
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

    await router.push('/agents/agent:reviewer:project');
    await flushPromises();
    expect(lifecycle.events).toEqual(['unsubscribe:agent:planner:project', 'clear:agent:planner:project', 'subscribe:agent:reviewer:project']);
    expect(store.selectedConversationSessionId).toBe('agent:reviewer:project');

    await router.push('/agents');
    await flushPromises();
    expect(lifecycle.events.slice(-2)).toEqual(['unsubscribe:agent:reviewer:project', 'clear:agent:reviewer:project']);
    expect(store.selectedConversationSessionId).toBeNull();
    wrapper.unmount();
  });
});
