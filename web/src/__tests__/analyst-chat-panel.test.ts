import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AnalystChatPanel from '../components/chat/AnalystChatPanel.vue';
import analystChatPanelSource from '../components/chat/AnalystChatPanel.vue?raw';
import { useAnalystChat } from '../stores/analystChat';

const listChatSessions = vi.fn();
const getChatEntries = vi.fn();
const sendChatMessage = vi.fn();

vi.mock('../api/client', () => ({
  listChatSessions: (...args: any[]) => listChatSessions(...args),
  getChatEntries: (...args: any[]) => getChatEntries(...args),
  sendChatMessage: (...args: any[]) => sendChatMessage(...args),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

describe('AnalystChatPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.useRealTimers();
    listChatSessions.mockReset();
    getChatEntries.mockReset();
    sendChatMessage.mockReset();
    listChatSessions.mockResolvedValue({ sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    getChatEntries.mockResolvedValue({
      sessionId: 'analyst:global',
      entries: [
        { id: '1', session_id: 'analyst:global', role: 'assistant', kind: 'text', content: 'hello', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2025-01-01T00:00:00Z' },
        { id: '2', session_id: 'analyst:global', role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'call-1', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] }), round_id: 'r-assistant-00000000000000000000000000000001', message_index: 1, block_index: 0, timestamp: '2025-01-01T00:00:01Z' },
        { id: '3', session_id: 'analyst:global', role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: 'call-1', content: JSON.stringify({ ok: true, content: 'docs' }), round_id: 'r-assistant-00000000000000000000000000000001', message_index: 1, block_index: 1, timestamp: '2025-01-01T00:00:02Z' },
      ],
    });
    sendChatMessage.mockResolvedValue({ sessionId: 'analyst:global', toolInvocations: [] });
  });

  it('wires pending chip growth through the shared timeline trigger', () => {
    expect(analystChatPanelSource).not.toContain('pendingToolInvocationsForActiveSession.value.length] as const');
    expect(analystChatPanelSource).toContain('extraPendingCount');
  });

  it('shows Loading history… during initial fetch and gates empty state until loading completes', async () => {
    let resolveMessages: (value: any) => void = () => {};
    getChatEntries.mockReturnValueOnce(new Promise((resolve) => { resolveMessages = resolve; }));
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('Loading history…');
    expect(wrapper.text()).not.toContain('No messages yet. Ask the analyst something.');

    resolveMessages({ sessionId: 'analyst:global', entries: [] });
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
    await resultChip!.find('button.tool-chip-toggle').trigger('click');

    // Raw JSON is NOT shown by default after expanding.
    const expandedBodyText = wrapper.findAll('.tool-chip-body').map((node) => node.text()).join('\n');
    expect(expandedBodyText).not.toContain('"ok":true');

    // Raw response is reachable only through the explicit raw toggle.
    const rawResponseToggle = resultChip!.findAll('button.raw-toggle').find((b) => b.text().includes('Show raw response'));
    expect(rawResponseToggle).toBeDefined();
    await rawResponseToggle!.trigger('click');
    expect(wrapper.findAll('.tool-chip-raw').map((node) => node.text()).join('\n')).toContain('"ok":true');
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

    expect(sendChatMessage).toHaveBeenCalledWith('analyst:global', 'please inspect', { view: null, entityId: null, refinement: null });
    expect(document.activeElement).toBe(textarea.element);
    wrapper.unmount();
  });

  it('renders a pending analyst tool chip before persisted messages catch up', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    const store = useAnalystChat();
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'stale-chat-id', tool: 'read', summary: 'opened docs', success: true });
    await flushPromises();

    expect(wrapper.text()).toContain('Read');
    expect(wrapper.text()).toContain('opened docs');
    expect(wrapper.find('.tool-chip').exists()).toBe(true);
    expect(store.pendingToolInvocations[0].sessionId).toBe('analyst:global');
    wrapper.unmount();
  });

  it('auto-scrolls pending chips while pinned and routes them to unseen count while paused', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    const store = useAnalystChat();
    const scrollArea = wrapper.find('.chat-scroll-area').element as HTMLElement;
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 200 });

    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'analyst:global', tool: 'read', summary: 'opened docs', success: true });
    await flushPromises();

    expect(scrollArea.scrollTop).toBe(1000);

    const pauseToggle = wrapper.find('label.auto-scroll-pause-toggle input[type="checkbox"]');
    expect(pauseToggle.exists()).toBe(true);
    await pauseToggle.setValue(true);
    scrollArea.scrollTop = 0;

    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'analyst:global', tool: 'run_command', summary: 'ran checks', success: true });
    await flushPromises();

    expect(scrollArea.scrollTop).toBe(0);
    expect(wrapper.text()).toContain('Jump to latest · 1 new');
    wrapper.unmount();
  });

  it('renders classified_as and related-card attribution for pending chips from sanitized events', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    const store = useAnalystChat();
    store.ingestWsEvent({
      event: 'analyst_tool_invoked',
      session_id: 'stale-chat-id',
      tool: 'run_command',
      summary: '[SECRET_PATH] redacted preview',
      classified_as: 'destructive',
      related_card_id: 'card-7',
      success: true,
    });
    await flushPromises();

    expect(wrapper.text()).toContain('Shell');
    expect(wrapper.text()).toContain('[SECRET_PATH] redacted preview');
    expect(wrapper.find('.tool-chip').exists()).toBe(true);
    expect(store.pendingToolInvocations[0].classifiedAs).toBe('destructive');
    expect(store.pendingToolInvocations[0].relatedCardId).toBe('card-7');
    expect(store.pendingToolInvocations[0].sessionId).toBe('analyst:global');
    wrapper.unmount();
  });
});
