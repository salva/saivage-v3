import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AnalystChatPanel from '../components/chat/AnalystChatPanel.vue';
import { useCardStore } from '../stores/cards';

const getChatEntries = vi.fn();
const getCardChildren = vi.fn();
const sendChatMessage = vi.fn();
const openConversation = vi.fn();
const closeConversation = vi.fn();

vi.mock('../api/client', () => ({
  getChatEntries: (...args: any[]) => getChatEntries(...args),
  getCardChildren: (...args: any[]) => getCardChildren(...args),
  sendChatMessage: (...args: any[]) => sendChatMessage(...args),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

vi.mock('../stores/liveSync', () => ({
  useLiveSyncStore: () => ({ openConversation }),
}));

describe('AnalystChatPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.useRealTimers();
    getChatEntries.mockReset();
    getCardChildren.mockReset();
    sendChatMessage.mockReset();
    openConversation.mockReset();
    closeConversation.mockReset();
    openConversation.mockImplementation((_sessionId: string, refetch: () => Promise<void>) => {
      void refetch();
      return closeConversation;
    });
    getChatEntries.mockResolvedValue({
      session: { id: 'analyst:global', role: 'analyst', status: 'inactive', started_at: '2025-01-01T00:00:00Z' },
      entries: [
        { id: '1', session_id: 'analyst:global', role: 'assistant', kind: 'text', content: 'hello', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2025-01-01T00:00:00Z' },
        { id: '2', session_id: 'analyst:global', role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'call-1', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] }), round_id: 'r-assistant-00000000000000000000000000000001', message_index: 1, block_index: 0, timestamp: '2025-01-01T00:00:01Z' },
        { id: '3', session_id: 'analyst:global', role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: 'call-1', content: JSON.stringify({ success: true, data: { content: 'docs', total_lines: 1 } }), round_id: 'r-assistant-00000000000000000000000000000001', message_index: 1, block_index: 1, timestamp: '2025-01-01T00:00:02Z' },
      ],
      activity_status: { status: 'inactive', pending_calls: [] },
    });
    getCardChildren.mockResolvedValue({ card: { id: 'project' }, children: [] });
    sendChatMessage.mockResolvedValue({ sessionId: 'analyst:global', toolInvocations: [], restart: null });
  });

  it('subscribes immediately, joins the existing root owner, and coalesces initial and pre-settlement refreshes', async () => {
    let resolveRoot!: (value: unknown) => void;
    const rootResponse = new Promise((resolve) => { resolveRoot = resolve; });
    getCardChildren.mockReturnValue(rootResponse);
    let callback!: () => Promise<void>;
    openConversation.mockImplementation((_sessionId: string, refetch: () => Promise<void>) => {
      callback = refetch;
      return closeConversation;
    });
    const pinia = createPinia();
    const existingRoot = useCardStore(pinia).ensureRoot();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();

    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(openConversation.mock.calls[0][0]).toBe('analyst:global');
    expect(getCardChildren).toHaveBeenCalledTimes(1);
    expect(getChatEntries).not.toHaveBeenCalled();

    await callback();
    await callback();
    expect(getChatEntries).not.toHaveBeenCalled();

    resolveRoot({ card: { id: 'project' }, children: [] });
    await existingRoot;
    await flushPromises();
    expect(getChatEntries).toHaveBeenCalledTimes(1);

    await callback();
    expect(getChatEntries).toHaveBeenCalledTimes(2);

    wrapper.unmount();
    expect(closeConversation).toHaveBeenCalledTimes(1);
  });

  it('admits one pending refresh when root initialization fails', async () => {
    getCardChildren.mockRejectedValueOnce(new Error('root failed'));
    openConversation.mockImplementation(() => closeConversation);
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(getChatEntries).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it('makes root settlement inert after unmount', async () => {
    let resolveRoot!: (value: unknown) => void;
    getCardChildren.mockReturnValue(new Promise((resolve) => { resolveRoot = resolve; }));
    openConversation.mockImplementation(() => closeConversation);
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(getChatEntries).not.toHaveBeenCalled();
    wrapper.unmount();
    resolveRoot({ card: { id: 'project' }, children: [] });
    await flushPromises();

    expect(getChatEntries).not.toHaveBeenCalled();
    expect(closeConversation).toHaveBeenCalledTimes(1);
  });

  it('refreshes the analyst transcript from canonical conversation live sync after root settlement', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(openConversation.mock.calls[0][0]).toBe('analyst:global');

    getChatEntries.mockClear();
    await openConversation.mock.calls[0][1]();
    expect(getChatEntries).toHaveBeenCalledWith(expect.any(AbortSignal));

    wrapper.unmount();
    expect(closeConversation).toHaveBeenCalledTimes(1);
  });

  it('initializes exactly one direct detail read after root settlement while disconnected', async () => {
    openConversation.mockImplementation(() => closeConversation);
    getChatEntries.mockResolvedValueOnce({ session: null, entries: [], activity_status: { status: 'inactive', pending_calls: [] } });
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(getChatEntries).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    expect(closeConversation).toHaveBeenCalledTimes(1);
  });

  it('keeps the subscription when detail initialization fails', async () => {
    openConversation.mockImplementation(() => closeConversation);
    getChatEntries.mockRejectedValueOnce(new Error('detail failed'));
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('detail failed');
    wrapper.unmount();
    expect(closeConversation).toHaveBeenCalledTimes(1);
  });

  it('lets a subscription refetch supersede an aborted initial detail response', async () => {
    let callback!: () => Promise<void>;
    openConversation.mockImplementation((_id: string, refetch: () => Promise<void>) => { callback = refetch; return closeConversation; });
    let resolveInitial!: (value: any) => void;
    const initial = new Promise((resolve) => { resolveInitial = resolve; });
    getChatEntries.mockReturnValueOnce(initial).mockResolvedValueOnce({
      session: { id: 'analyst:global', role: 'analyst', status: 'inactive', started_at: '2025-01-01T00:00:00Z' },
      entries: [{ id: 'new', session_id: 'analyst:global', role: 'assistant', kind: 'text', content: 'newest', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2025-01-01T00:00:00Z' }],
      activity_status: { status: 'inactive', pending_calls: [] },
    });
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    await callback();
    resolveInitial({ session: null, entries: [], activity_status: { status: 'inactive', pending_calls: [] } });
    await flushPromises();
    expect(wrapper.text()).toContain('newest');
    wrapper.unmount();
  });

  it('shows Loading history… during initial fetch and gates empty state until loading completes', async () => {
    let resolveMessages: (value: any) => void = () => {};
    const pending = new Promise((resolve) => { resolveMessages = resolve; });
    getChatEntries.mockReturnValue(pending);
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('Loading history…');
    expect(wrapper.text()).not.toContain('No messages yet. Ask the analyst something.');

    resolveMessages({ session: null, entries: [], activity_status: { status: 'inactive', pending_calls: [] } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Loading history…');
    expect(wrapper.text()).toContain('No messages yet. Ask the analyst something.');
    wrapper.unmount();
  });

  it('renders one writable analyst chat without a session picker or new-chat control', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.find('button.secondary-btn').exists()).toBe(false);
    expect(wrapper.find('textarea').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('textarea').attributes('title')).toBe('Ask the analyst…');
    expect(wrapper.find('button.chat-send-button').attributes('title')).toBe('Ask the analyst…');
    wrapper.unmount();
  });

  it.each([
    ['active', 'Active'],
    ['waiting', 'Waiting for webfetch'],
  ] as const)('renders exact %s detail activity through the shared timeline footer', async (status, copy) => {
    getChatEntries.mockResolvedValueOnce({
      session: { id: 'analyst:global', role: 'analyst', status, started_at: '2025-01-01T00:00:00Z' },
      entries: [{ id: 'activity-entry', session_id: 'analyst:global', role: 'assistant', kind: 'text', content: 'working', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2025-01-01T00:00:00Z' }],
      activity_status: { status, pending_calls: status === 'waiting' ? [{ id: 'call-1', tool: 'webfetch', started_at: '2025-01-01T00:00:01Z' }] : [] },
    });
    openConversation.mockImplementation(() => closeConversation);
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain(copy);
    expect(wrapper.text()).not.toContain('Analyst is thinking');
    wrapper.unmount();
  });

  it('renders messages and tool chips with expand/collapse', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('hello');
    const chips = wrapper.findAll('.tool-chip');
    expect(chips[0].text()).toContain('Read');
    expect(chips[0].text()).toContain('README.md');
    const toggle = chips[0].find('button.tool-chip-toggle');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    expect(chips[0].find('button.tool-chip-toggle').attributes('aria-expanded')).toBe('true');
    expect(chips[0].find('button.tool-chip-toggle').attributes('aria-label')).toContain('Collapse tool read details');
    expect(wrapper.findAll('.tool-chip-body').map((node) => node.text()).join('\n')).toContain('README.md');
    await chips[0].find('button.tool-chip-toggle').trigger('click');
    expect(wrapper.find('.tool-chip-body').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders tool result messages as human-readable status labels and gates raw JSON behind a toggle', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    const chips = wrapper.findAll('.tool-chip');
    const resultChip = chips.find((chip) => chip.classes().includes('tool-chip-ok'));
    expect(resultChip).toBeDefined();
    expect(chips).toHaveLength(1);
    expect(resultChip!.text()).toContain('Read');
    expect(resultChip!.text()).toContain('1 lines');
    expect(resultChip!.text()).not.toContain('docs');
    await resultChip!.find('button.tool-chip-toggle').trigger('click');

    // Raw JSON is NOT shown by default after expanding.
    const expandedBodyText = wrapper.findAll('.tool-chip-body').map((node) => node.text()).join('\n');
    expect(expandedBodyText).not.toContain('docs');
    expect(expandedBodyText).not.toContain('"content"');

    // Raw response is reachable only through the explicit raw toggle.
    const rawResponseToggle = resultChip!.findAll('button.raw-toggle').find((b) => b.text().includes('Show raw response'));
    expect(rawResponseToggle).toBeDefined();
    await rawResponseToggle!.trigger('click');
    const rawText = wrapper.findAll('.tool-chip-raw').map((node) => node.text()).join('\n');
    expect(rawText).toContain('"success":true');
    expect(rawText).toContain('"content":"docs"');
    wrapper.unmount();
  });

  it('focuses the composer when saivage:focus-chat is dispatched', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement;
    button.focus();
    expect(document.activeElement).toBe(button);

    window.dispatchEvent(new CustomEvent('saivage:focus-chat'));
    await flushPromises();

    expect(document.activeElement).toBe(textarea);
    wrapper.unmount();
    button.remove();
  });

  it('submits composer on Enter and keeps focus on the composer', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    const textarea = wrapper.find('textarea');
    await textarea.setValue('please inspect');
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });
    await flushPromises();

    expect(sendChatMessage).toHaveBeenCalledWith('please inspect', { view: null, entityId: null, refinement: null });
    expect(document.activeElement).toBe(textarea.element);
    wrapper.unmount();
  });

  it('renders the exact restart confirmation warning above the composer without a transcript entry', async () => {
    sendChatMessage.mockResolvedValueOnce({
      sessionId: 'analyst:global',
      toolInvocations: [],
      restart: { status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' },
    });
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    await wrapper.find('textarea').setValue('restart the server');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const warning = wrapper.find('.chat-input-panel [role="status"]');
    expect(warning.text()).toBe('Restart confirmation required. Send exactly RESTART SERVER to schedule server shutdown.');
    expect(wrapper.findAll('.chat-round').length).toBeGreaterThanOrEqual(0);
    expect(wrapper.text()).not.toContain('Server restart scheduled');
    wrapper.unmount();
  });

});
