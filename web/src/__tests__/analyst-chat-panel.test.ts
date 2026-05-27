import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AnalystChatPanel from '../components/chat/AnalystChatPanel.vue';
import { useAnalystChat } from '../stores/analystChat';

const listChatSessions = vi.fn();
const getChatMessages = vi.fn();
const sendChatMessage = vi.fn();

vi.mock('../api/client', () => ({
  listChatSessions: (...args: any[]) => listChatSessions(...args),
  getChatMessages: (...args: any[]) => getChatMessages(...args),
  sendChatMessage: (...args: any[]) => sendChatMessage(...args),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

describe('AnalystChatPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.useRealTimers();
    listChatSessions.mockReset();
    getChatMessages.mockReset();
    sendChatMessage.mockReset();
    listChatSessions.mockResolvedValue({ sessions: [{ id: 'analyst', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    getChatMessages.mockResolvedValue({
      sessionId: 'analyst',
      messages: [
        { id: '1', session_id: 'analyst', role: 'assistant', kind: 'text', content: 'hello', round_id: 'r-assistant-1', message_index: 0, block_index: 0, timestamp: '2025-01-01T00:00:00Z' },
        { id: '2', session_id: 'analyst', role: 'assistant', kind: 'tool_call', tool: 'read_file', tool_call_id: 'call-1', content: JSON.stringify({ toolCalls: [{ id: 'call-1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }), round_id: 'r-assistant-1', message_index: 1, block_index: 0, timestamp: '2025-01-01T00:00:01Z' },
        { id: '3', session_id: 'analyst', role: 'tool', kind: 'tool_result', tool: 'read_file', tool_call_id: 'call-1', content: JSON.stringify({ ok: true, content: 'docs' }), round_id: 'r-assistant-1', message_index: 1, block_index: 1, timestamp: '2025-01-01T00:00:02Z' },
      ],
    });
    sendChatMessage.mockResolvedValue({ sessionId: 'analyst', message: { id: '4', content: 'reply', timestamp: '2025-01-01T00:00:03Z' } });
  });

  it('shows Loading history… during initial fetch and gates empty state until loading completes', async () => {
    let resolveMessages: (value: any) => void = () => {};
    getChatMessages.mockReturnValueOnce(new Promise((resolve) => { resolveMessages = resolve; }));
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    expect(wrapper.text()).toContain('Loading history…');
    expect(wrapper.text()).not.toContain('No messages yet. Ask the analyst something.');

    resolveMessages({ sessionId: 'analyst', messages: [] });
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
    expect(chips[0].text()).toContain('read_file');
    expect(chips[0].text()).toContain('README.md');
    const toggle = chips[0].find('button.tool-chip-toggle');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    expect(chips[0].find('button.tool-chip-toggle').attributes('aria-expanded')).toBe('true');
    expect(chips[0].find('button.tool-chip-toggle').attributes('aria-label')).toContain('Collapse tool read_file details');
    expect(wrapper.findAll('.tool-chip-body').map((node) => node.text()).join('\n')).toContain('README.md');
    await chips[0].find('button.tool-chip-toggle').trigger('click');
    expect(wrapper.find('.tool-chip-body').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders tool result messages as human-readable status labels with raw details', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();

    const chips = wrapper.findAll('.tool-chip');
    const resultChip = chips.find((chip) => chip.classes().includes('tool-chip-ok'));
    expect(resultChip).toBeDefined();
    expect(chips).toHaveLength(1);
    expect(resultChip!.text()).toContain('read_file');
    await resultChip!.find('button.tool-chip-toggle').trigger('click');
    expect(wrapper.findAll('.tool-chip-body').map((node) => node.text()).join('\n')).toContain('"ok":true');
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

    expect(sendChatMessage).toHaveBeenCalledWith('analyst', 'please inspect', { view: null, entityId: null, refinement: null });
    expect(document.activeElement).toBe(textarea.element);
    wrapper.unmount();
  });

  it('renders a pending analyst tool chip before persisted messages catch up', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    const store = useAnalystChat();
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'stale-chat-id', tool: 'read_file', summary: 'opened docs', success: true });
    await flushPromises();

    expect(wrapper.text()).toContain('read_file');
    expect(wrapper.text()).toContain('opened docs');
    expect(wrapper.find('.tool-chip').exists()).toBe(true);
    expect(store.pendingToolInvocations[0].sessionId).toBe('analyst');
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
      tool: 'run_shell_command',
      summary: '[SECRET_PATH] redacted preview',
      classified_as: 'destructive',
      related_card_id: 'card-7',
      success: true,
    });
    await flushPromises();

    expect(wrapper.text()).toContain('run_shell_command');
    expect(wrapper.text()).toContain('[SECRET_PATH] redacted preview');
    expect(wrapper.find('.tool-chip').exists()).toBe(true);
    expect(store.pendingToolInvocations[0].classifiedAs).toBe('destructive');
    expect(store.pendingToolInvocations[0].relatedCardId).toBe('card-7');
    expect(store.pendingToolInvocations[0].sessionId).toBe('analyst');
    wrapper.unmount();
  });
});
