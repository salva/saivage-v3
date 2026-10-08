import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DURABLE_PRIMARY_CONTENT_POLICY } from '../api/contracts';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { nextTick, type Ref } from 'vue';
import AgentConversationView from '../components/agents/AgentConversationView.vue';
import CockpitView from '../views/CockpitView.vue';
import agentConversationSource from '../components/agents/AgentConversationView.vue?raw';
import conversationsFacetSource from '../components/cockpit/CardConversationsFacet.vue?raw';
import rawPanelSource from '../components/agents/RawLlmExchangePanel.vue?raw';
import { OperatorApiError } from '../api/client';
import type { AgentConversationEntry, AgentConversationResponse } from '../api/types';
import type { ConversationInvalidation } from '../sync/client';
import { useAgentStore } from '../stores/agents';
import { cyclicCodePresentation } from './cockpit/fixtures';

const lifecycle = vi.hoisted(() => ({
  events: [] as string[],
  callbacks: new Map<string, (frame: ConversationInvalidation) => Promise<void>>(),
}));
const api = vi.hoisted(() => ({
  getAgentConversation: vi.fn(),
  getAgentSession: vi.fn(),
  getAgentLlmExchange: vi.fn(),
  getAgentConversationVersion: vi.fn(),
  listAgentConversationVersions: vi.fn(),
}));
const live = vi.hoisted(() => ({
  connectionState: null as Ref<'connected' | 'connecting' | 'offline' | 'unauthorized'> | null,
  openLlmExchange: vi.fn(),
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
      openLlmExchange: live.openLlmExchange,
      openCardAgentSessions: () => () => {},
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
  getAgentConversationVersion: api.getAgentConversationVersion,
  listAgentConversationVersions: api.listAgentConversationVersions,
  getAgentLlmExchange: api.getAgentLlmExchange,
  getCard: vi.fn(async () => ({ card: { id: 'project', type: 'project', title: 'Project', lifecycle: { status: 'running', result: null, error: null, completed_at: null }, version_seq: 1, urgency: 'normal', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', allowedActions: [] } })),
  getCardAgentSessions: vi.fn(async () => ({ sessions: [] })),
  getWorkflowPresentation: vi.fn(async () => ({ ...cyclicCodePresentation(), card_type: 'project' })),
  getCardChildren: vi.fn(async (id: string) => ({ parent: { id, type: 'project', title: 'Project', status: 'running', permitted_child_types: [] }, children: [] })),
  listCardRecords: vi.fn(async () => ({ card_id: 'project', records: [] })),
}));

function makeSession(id: string) {
  return { id, agent_name: id.split(':')[1], session_scope: id.endsWith(':global') ? 'global' as const : 'card' as const, card_id: id.endsWith(':global') ? null : 'project', started_at: '2026-01-01T00:00:00.000Z', status: 'inactive' as const, activity: 'idle' as const, compaction: null };
}

function activation(sessionId: AgentConversationEntry['session_id'], suffix: string): AgentConversationEntry {
  const timestamp = '2026-10-02T12:00:00.000Z';
  return { ...textEntry(`${sessionId}:activation:${suffix}`, 0), session_id: sessionId, role: 'system', kind: 'activity', timestamp,
    context_policy: { kind: 'structural', behavior: 'activation_boundary' },
    content: JSON.stringify({ event: 'activation_open', agent_name: sessionId.split(':')[1], ...(sessionId.endsWith(':global') ? {} : { card_id: 'project' }), input_id: '11111111-1111-4111-8111-111111111111', timestamp }),
  };
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
    segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1,
    segment_context: null,
    entries,
    cursor: { segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, message_id: messageId },
  };
}

function toolRows(id: string, round: number, tool = 'read'): AgentConversationEntry[] {
  const base = { ...textEntry(id, round), tool, tool_call_id: `invocation-${id}` };
  return [
    { ...base, kind: 'tool_call', content: JSON.stringify({ tool_calls: [{ id: base.tool_call_id, type: 'function', function: { name: tool, arguments: JSON.stringify({ path: 'README.md' }) } }] }) },
    { ...base, id: `${id}:result`, role: 'tool', kind: 'tool_result', block_index: 1, content: JSON.stringify({ success: true, data: { content: 'raw-only-response' } }) },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

let evidenceLookups = 0;
let centerScrolls = 0;
let originalQuerySelectorAll: typeof Element.prototype.querySelectorAll;
let originalBoundingRect: typeof HTMLElement.prototype.getBoundingClientRect;

function installViewportModel(): void {
  originalQuerySelectorAll = Element.prototype.querySelectorAll;
  Element.prototype.querySelectorAll = function <E extends Element = Element>(selectors: string): NodeListOf<E> {
    if (selectors === '[data-entry-id]') evidenceLookups += 1;
    return originalQuerySelectorAll.call(this, selectors) as NodeListOf<E>;
  };
  originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    if (this.hasAttribute('data-entry-id')) {
      centerScrolls += 1;
      const viewport = this.closest('.conv-rounds') as HTMLElement;
      return { top: 400 + 200 / 3 - viewport.scrollTop } as DOMRect;
    }
    return { top: 0 } as DOMRect;
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
  const router = makeRouter();
  await router.push('/agents/agent:planner:project');
  await router.isReady();
  const wrapper = mount(AgentConversationView, {
    props: { sessionId: 'agent:planner:project', entryId },
    global: {
      plugins: [pinia, router],
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
      { path: '/agents/:id', name: 'agent-detail', component: CockpitView },
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
    api.listAgentConversationVersions.mockResolvedValue({ versions: [] });
    evidenceLookups = 0;
    centerScrolls = 0;
    installViewportModel();
  });

  afterEach(() => {
    Element.prototype.querySelectorAll = originalQuerySelectorAll;
    HTMLElement.prototype.getBoundingClientRect = originalBoundingRect;
    delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
  });

  it('has keyed children, view-local evidence targeting, and no eager exchange fetch', () => {
    expect(conversationsFacetSource).toContain(':key="selectedSessionId"');
    expect(agentConversationSource).toContain(':key="props.sessionId"');
    expect(rawPanelSource).not.toContain('watch(');
    expect(rawPanelSource).not.toContain('maybeFetch');
    expect(conversationsFacetSource).toContain(':entry-id="entryId"');
  });
  it('opens passive technical metadata only on disclosure and releases its selection on close/departure', async () => {
    const closeExchange = vi.fn();
    api.getAgentLlmExchange.mockRejectedValue(new OperatorApiError('agents.llmExchange', 404, { error: 'llm_exchange_not_found' }));
    live.openLlmExchange.mockImplementation((_id, onFrame) => { void onFrame(null); return closeExchange; });
    const { wrapper, store, callback } = await mountConversation('');
    const clearSelection = vi.spyOn(store, 'clearLlmExchange');
    await callback(null); await flushPromises();
    expect(live.openLlmExchange).not.toHaveBeenCalled();
    expect(api.getAgentLlmExchange).not.toHaveBeenCalled();
    const disclosure = wrapper.get('.technical-details');
    expect((disclosure.element as HTMLDetailsElement).open).toBe(false);
    (disclosure.element as HTMLDetailsElement).open = true;
    await disclosure.trigger('toggle'); await flushPromises();
    expect(live.openLlmExchange).toHaveBeenCalledWith('agent:planner:project', expect.any(Function));
    expect(api.getAgentLlmExchange).toHaveBeenCalledTimes(1);
    await wrapper.get('.rlp-refresh').trigger('click'); await flushPromises();
    expect(api.getAgentLlmExchange).toHaveBeenCalledTimes(2);
    (disclosure.element as HTMLDetailsElement).open = false;
    await disclosure.trigger('toggle'); await flushPromises();
    expect(wrapper.find('.raw-llm-panel').exists()).toBe(false);
    expect(closeExchange).toHaveBeenCalledTimes(1);
    expect(clearSelection).toHaveBeenCalledTimes(1);
    (disclosure.element as HTMLDetailsElement).open = true;
    await disclosure.trigger('toggle'); await flushPromises();
    expect(api.getAgentLlmExchange).toHaveBeenCalledTimes(3);
    wrapper.unmount();
    expect(closeExchange).toHaveBeenCalledTimes(2);
    expect(clearSelection).toHaveBeenCalledTimes(2);
  });
  it('preserves selected disclosures on same-identity refresh and resets on same-ordinal identity replacement', async () => {
    const context: NonNullable<AgentConversationResponse['segment_context']> = {
      kind: 'compacted', source_version: 1, covered_through_message_id: 'covered', summary_text: 'Actual selected summary final-Z',
      protected_prompts: [], required_model_facts: { latestRecovery: null, latestContentPolicyRefusal: null }, continuation: { kind: 'between_rounds' },
    };
    let identity = '11111111-1111-4111-8111-111111111111';
    api.getAgentConversation.mockImplementation(async () => ({ ...response([]), segment_id: identity, segment_context: context }));
    const { wrapper, callback } = await mountConversation('');
    await callback(null); await flushPromises();
    const summary = wrapper.get('[data-testid="compacted-summary"]').element as HTMLDetailsElement;
    summary.open = true;
    expect(wrapper.findAll('button').some(button => ['Expand all', 'Collapse all'].includes(button.text()))).toBe(false);
    expect(wrapper.text()).not.toContain('Pause auto-scroll');
    await callback(null); await flushPromises();
    expect(wrapper.get('[data-testid="compacted-summary"]').element).toBe(summary);
    expect(summary.open).toBe(true);
    identity = '22222222-2222-4222-8222-222222222222';
    await callback(null); await flushPromises();
    expect((wrapper.get('[data-testid="compacted-summary"]').element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.get('[data-testid="compacted-summary"]').element).not.toBe(summary);
    wrapper.unmount();
  });

  it('presents the gated first transcript as waiting until acknowledgement loads its baseline', async () => {
    live.connectionState!.value = 'offline';
    api.getAgentConversation.mockResolvedValueOnce(response([textEntry('first', 1)]));
    const { wrapper, callback } = await mountConversation('');

    expect(wrapper.text()).toContain('Waiting for conversation');
    expect(wrapper.text()).toContain('Live sync is not connected');
    expect(wrapper.find('.conv-rounds').exists()).toBe(true);
    expect(wrapper.find('.conversation-timeline').exists()).toBe(false);
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

  it('reports an unauthorized live connection honestly without requesting the transcript prematurely', async () => {
    live.connectionState!.value = 'unauthorized';
    const { wrapper } = await mountConversation('');
    await flushPromises();

    expect(wrapper.text()).toContain(
      'Live connection unauthorized. The conversation loads when an authorized browser connection is available.',
    );
    expect(wrapper.text()).not.toContain('The conversation will load when the live connection is re-established.');
    expect(wrapper.text()).not.toContain('subscription acknowledgement');
    expect(api.getAgentConversation).not.toHaveBeenCalled();
    wrapper.unmount();
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

    expect(evidenceLookups).toBe(0);
    expect(centerScrolls).toBe(0);
    expect(wrapper.text()).toContain('requested conversation entry was not found');
  });

  it('reveals the combined owner and focuses separate exact call and result anchors', async () => {
    const opaque = ' opaque "[] # % call ';
    api.getAgentConversation.mockResolvedValueOnce(response([
      ...toolRows('standalone', 1, 'custom_probe'),
      ...toolRows('group-first', 2), ...toolRows(opaque, 2),
      ...toolRows('unrelated-first', 3), ...toolRows('unrelated-second', 3),
    ]));
    const { wrapper, callback } = await mountConversation('standalone');
    await callback(null);
    await flushPromises();
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe('standalone');
    expect(wrapper.findAll('.tool-group-body')).toHaveLength(0);
    await wrapper.setProps({ entryId: opaque });
    await flushPromises();
    const chip = wrapper.get('.targeted-conversation-entry');
    expect(chip.attributes('data-entry-id')).toBe(opaque);
    expect(chip.classes()).toContain('tool-request');
    expect(chip.attributes('tabindex')).toBe('-1');
    expect(wrapper.findAll('.tool-group-body')).toHaveLength(0);
    expect(wrapper.findAll('.tool-chip')).toHaveLength(5);
    expect(wrapper.findAll('.tool-chip-detail')).toHaveLength(2);
    expect(wrapper.get(`[data-tool-entry-id='standalone'] .tool-chip-toggle`).attributes('aria-expanded')).toBe('true');
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');
    await wrapper.setProps({ entryId: `${opaque}:result` });
    await flushPromises();
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe(`${opaque}:result`);
    wrapper.unmount();
  });

  it.each(['change', 'invalid', 'unmount'] as const)('cancels obsolete exact-row focus on %s', async (action) => {
    api.getAgentConversation.mockResolvedValueOnce(response([
      ...toolRows('group-first', 1), ...toolRows('group-target', 1), ...toolRows('new-target', 2, 'custom_probe'),
    ]));
    const { wrapper, callback } = await mountConversation('');
    await callback(null);
    await flushPromises();
    centerScrolls = 0;
    void wrapper.setProps({ entryId: 'group-target' });
    if (action === 'unmount') wrapper.unmount();
    else void wrapper.setProps(action === 'invalid' ? { invalidSegment: true } : { entryId: 'new-target' });
    await flushPromises();
    expect(centerScrolls).toBe(action === 'change' ? 1 : 0);
    if (action !== 'unmount') {
      expect(wrapper.text()).not.toContain('requested conversation entry was not found');
      if (action === 'change') expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe('new-target');
      else expect(wrapper.find('.targeted-conversation-entry').exists()).toBe(false);
      wrapper.unmount();
    }
  });

  it('keeps exact row selection isolated from current updates and fails closed for invalid segments and projection errors', async () => {
    const id = 'exact-group-call';
    api.getAgentConversationVersion.mockResolvedValue({ session_id: 'agent:planner:project', version: 1, segment_context: null, entries: [...toolRows('first', 1), ...toolRows(id, 1)] });
    const router = makeRouter();
    await router.push({ name: 'agent-detail', params: { id: 'agent:planner:project' }, query: { segment: '1', entry: id } });
    const pinia = createPinia();
    const wrapper = mount(CockpitView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe(id);
    useAgentStore(pinia).entries = [...toolRows('current-first', 2), ...toolRows('current-call', 2)];
    useAgentStore(pinia).conversationError = 'current failed';
    await flushPromises();
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe(id);
    expect(wrapper.text()).not.toContain('current failed');
    await router.push({ query: { segment: 'bad', entry: id } });
    await flushPromises();
    expect(wrapper.text()).toContain('Invalid segment selection');
    expect(wrapper.find('.tool-group-body').exists()).toBe(false);
    api.getAgentConversationVersion.mockResolvedValue({ session_id: 'agent:planner:project', version: 2, segment_context: null, entries: [...toolRows('first', 1), ...toolRows(id, 1), { ...activation('agent:planner:project', '0123456789abcdef'), content: '{"event":"activation_open"}' }] });
    await router.push({ query: { segment: '2', entry: id } });
    await flushPromises();
    expect(wrapper.text()).toContain('Malformed activation_open');
    expect(wrapper.find('.tool-chip').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');
    wrapper.unmount();
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
    await callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, visible_message_id: 'target' });
    await flushPromises();
    expect(evidenceLookups).toBe(1);
    expect(centerScrolls).toBe(1);
    expect((wrapper.get('.conv-rounds').element as HTMLElement).scrollTop).toBe(400);
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');

    await callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_id: '22222222-2222-4222-8222-222222222222', segment_version: 2, visible_message_id: 'target-3' });
    await flushPromises();
    expect(evidenceLookups).toBe(2);
    expect(centerScrolls).toBe(2);

    await callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_id: '33333333-3333-4333-8333-333333333333', segment_version: 3, visible_message_id: 'target-4' });
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

    await expect(callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, visible_message_id: 'next' })).rejects.toThrow('refresh failed');
    await flushPromises();

    expect(evidenceLookups).toBe(0);
    expect(centerScrolls).toBe(0);
    expect(wrapper.get('[data-entry-id="target"]').classes()).toContain('targeted-conversation-entry');
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');
  });
  it('does not refocus an unchanged target anchor during same-selection live arrival', async () => {
    api.getAgentConversation
      .mockResolvedValueOnce(response([textEntry('target', 1)]))
      .mockResolvedValueOnce(response([textEntry('arrival', 2)]));
    const { wrapper, callback } = await mountConversation('target');
    await callback(null); await flushPromises();
    const viewport = wrapper.get('.conv-rounds').element as HTMLElement;
    viewport.scrollTop = 120;
    centerScrolls = 0;
    await callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, visible_message_id: 'arrival' });
    await flushPromises();
    expect(centerScrolls).toBe(0);
    expect(viewport.scrollTop).toBe(120);
    expect(wrapper.find('.targeted-conversation-entry').attributes('data-entry-id')).toBe('target');
    wrapper.unmount();
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
    expect(initial.wrapper.find('.conversation-timeline').exists()).toBe(false);
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
      segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1,
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
          requested_segment_id: '11111111-1111-4111-8111-111111111111', requested_segment_version: 1,
          current_segment_id: '22222222-2222-4222-8222-222222222222', current_segment_version: 2,
        }),
      )
      .mockImplementationOnce(() => authoritative.promise);
    const { wrapper, store, callback } = await mountConversation('target');
    await callback(null);
    await flushPromises();
    evidenceLookups = 0;
    centerScrolls = 0;

    const recovery = callback({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, visible_message_id: 'next' });
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
          requested_segment_id: '11111111-1111-4111-8111-111111111111', requested_segment_version: 1,
          current_segment_id: '22222222-2222-4222-8222-222222222222', current_segment_version: 2,
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
      segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1,
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
    const wrapper = mount(CockpitView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    lifecycle.events.length = 0;

    await router.push('/agents/agent:reviewer:project');
    await flushPromises();
    expect(lifecycle.events).toEqual(['unsubscribe:agent:planner:project', 'clear:agent:planner:project', 'subscribe:agent:reviewer:project']);
    expect(store.selectedConversationSessionId).toBe('agent:reviewer:project');

    await router.push('/cards/11111111-1111-4111-8111-111111111111');
    await flushPromises();
    expect(lifecycle.events.slice(-2)).toEqual(['unsubscribe:agent:reviewer:project', 'clear:agent:reviewer:project']);
    expect(store.selectedConversationSessionId).toBeNull();
    wrapper.unmount();
  });

  it.each([
    ['agent:planner:project', '0123456789abcdef'],
    ['agent:oversight:global', '11111111-1111-4111-8111-111111111111'],
  ] as const)('mounts real opaque markers through cold exact routing, reload, same-session switches and Back: %s', async (sessionId, suffix) => {
    const first = activation(sessionId, suffix);
    const second = activation(sessionId, sessionId.endsWith(':global') ? '22222222-2222-4222-8222-222222222222' : 'fedcba9876543210');
    api.getAgentConversationVersion.mockImplementation(async (_id: string, version: number) => ({ session_id: sessionId, version, segment_context: null, entries: [version === 1 ? first : second] }));
    const router = makeRouter();
    const link = { name: 'agent-detail', params: { id: sessionId }, query: { segment: '1', entry: first.id } };
    await router.push(link);
    const pinia = createPinia();
    let wrapper = mount(CockpitView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe(first.id);
    expect(wrapper.get('[data-testid="activation-index"]').text()).toContain('segment 1 (exact selection)');
    expect(wrapper.get('details.version-history').attributes()).toHaveProperty('open');
    wrapper.unmount();
    wrapper = mount(CockpitView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe(first.id);
    await router.push({ ...link, query: { segment: '2', entry: second.id } });
    await flushPromises();
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe(second.id);
    useAgentStore(pinia).entries = [textEntry('background-current', 1)];
    useAgentStore(pinia).conversationError = 'Current reader failed';
    useAgentStore(pinia).conversationLoading = true;
    await flushPromises();
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe(second.id);
    expect(wrapper.text()).not.toContain('Current reader failed');
    router.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe(first.id);
    await router.push({ ...link, query: { segment: '1', entry: ' opaque "[] # % target ' } });
    await flushPromises();
    expect(wrapper.text()).toContain('not found in the selected exact segment');
    expect(router.currentRoute.value.query.entry).toBe(' opaque "[] # % target ');
    expect(wrapper.find('.targeted-conversation-entry').exists()).toBe(false);
    const uuid = '33333333-3333-4333-8333-333333333333';
    api.getAgentConversationVersion.mockResolvedValue({ session_id: sessionId, version: 2, segment_context: null, entries: [{ ...textEntry(uuid, 0), session_id: sessionId }] });
    await router.push({ ...link, query: { segment: '2', entry: uuid } });
    await flushPromises();
    expect(wrapper.get('.targeted-conversation-entry').attributes('data-entry-id')).toBe(uuid);
    for (const entry of ['', ['a', 'b']]) {
      await router.push({ ...link, query: { segment: '2', entry } });
      await flushPromises();
      expect(wrapper.find('.targeted-conversation-entry').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('requested conversation entry was not found');
    }
    const calls = api.getAgentConversationVersion.mock.calls.length;
    for (const segment of ['0', 'no', '1.5', '9007199254740992', ['1', '2']]) {
      await router.push({ ...link, query: { segment, entry: first.id } });
      await flushPromises();
      expect(wrapper.text()).toContain('Invalid segment selection');
    }
    expect(api.getAgentConversationVersion.mock.calls).toHaveLength(calls);
    wrapper.unmount();
  });

  it('fences same-session exact requests, including current-equal selection, and distinguishes failed reads', async () => {
    const late = deferred<unknown>();
    api.getAgentConversationVersion.mockImplementation((_id: string, version: number) => version === 1 ? late.promise : Promise.resolve({ session_id: 'agent:planner:project', version, segment_context: null, entries: [] }));
    const router = makeRouter();
    await router.push('/agents/agent:planner:project?segment=1&entry=unknown');
    const pinia = createPinia();
    const wrapper = mount(CockpitView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await router.push('/agents/agent:planner:project?segment=2&entry=unknown');
    await flushPromises();
    late.resolve({ session_id: 'agent:planner:project', version: 1, entries: [activation('agent:planner:project', '0123456789abcdef')], segment_context: null });
    await flushPromises();
    expect(useAgentStore(pinia).selectedConversationVersion?.version).toBe(2);
    expect(wrapper.text()).toContain('not found in the selected exact segment');
    api.getAgentConversationVersion.mockRejectedValueOnce(new OperatorApiError('agents.conversationVersions.get', 404, { error: 'historical_version_not_found', resource: 'conversation', owner_id: 'agent:planner:project', version: 3 }));
    await router.push('/agents/agent:planner:project?segment=3&entry=unknown');
    await flushPromises();
    expect(wrapper.text()).toContain('This exact segment is not available');
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');
    api.getAgentConversationVersion.mockRejectedValueOnce(new Error('segment read failed'));
    await router.push('/agents/agent:planner:project?segment=4&entry=unknown');
    await flushPromises();
    expect(wrapper.text()).toContain('segment read failed');
    wrapper.unmount();
  });

  it('keeps inherited continuation separate from entries and rejects a malformed claimed marker visibly', async () => {
    const marker = activation('agent:planner:project', '0123456789abcdef');
    const context = {
      kind: 'compacted', source_version: 1, covered_through_message_id: 'old-row', summary_text: 'Prior context',
      protected_prompts: [], required_model_facts: { latestRecovery: null, latestContentPolicyRefusal: null }, continuation: { kind: 'inherited_open_round', activation: { marker_id: marker.id, input_id: '11111111-1111-4111-8111-111111111111' }, active_segment_kind: 'initial' },
    };
    api.getAgentConversationVersion.mockResolvedValue({ session_id: 'agent:planner:project', version: 2, entries: [], segment_context: context });
    const router = makeRouter();
    await router.push('/agents/agent:planner:project?segment=2');
    const pinia = createPinia();
    const wrapper = mount(CockpitView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Continuation context');
    expect(wrapper.text()).toContain(marker.id);
    expect(wrapper.get('[data-testid="activation-index"]').text()).toContain('No activation markers retained in this segment');
    expect(wrapper.find('.activation-marker').exists()).toBe(false);
    api.getAgentConversationVersion.mockResolvedValue({ session_id: 'agent:planner:project', version: 1, entries: [{ ...marker, content: '{"event":"activation_open"}' }], segment_context: null });
    await router.push('/agents/agent:planner:project?segment=1&entry=unknown');
    await flushPromises();
    expect(wrapper.text()).toContain('Malformed activation_open');
    expect(wrapper.text()).not.toContain('No activation markers retained');
    expect(wrapper.text()).not.toContain('requested conversation entry was not found');
    wrapper.unmount();
  });
});
