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
    listChatSessions.mockResolvedValue({ sessions: [{ id: 'chat-1', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    getChatMessages.mockResolvedValue({
      sessionId: 'chat-1',
      messages: [
        { id: '1', session_id: 'chat-1', role: 'assistant', kind: 'text', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
        { id: '2', session_id: 'chat-1', role: 'tool', kind: 'tool_call', tool: 'read_file', content: JSON.stringify({ toolCalls: [{ tool: 'read_file', params: { path: 'README.md' } }] }), timestamp: '2025-01-01T00:00:01Z' },
        { id: '3', session_id: 'chat-1', role: 'tool', kind: 'tool_result', tool: 'read_file', content: JSON.stringify({ ok: true, content: 'docs' }), timestamp: '2025-01-01T00:00:02Z' },
      ],
    });
    sendChatMessage.mockResolvedValue({ sessionId: 'chat-1', message: { id: '4', content: 'reply', timestamp: '2025-01-01T00:00:03Z' } });
  });

  it('renders messages and tool chips with expand/collapse', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    await wrapper.find('select').setValue('chat-1');
    await flushPromises();
    expect(wrapper.text()).toContain('hello');
    const chips = wrapper.findAll('.tool-chip');
    expect(chips[0].text()).toContain('read_file');
    expect(chips[0].attributes('aria-expanded')).toBe('false');
    await chips[0].trigger('click');
    expect(chips[0].attributes('aria-expanded')).toBe('true');
    expect(chips[0].attributes('aria-label')).toContain('Collapse analyst tool call details');
    expect(wrapper.find('.tool-chip-detail').text()).toContain('README.md');
    await chips[0].trigger('click');
    expect(wrapper.find('.tool-chip-detail').exists()).toBe(false);
    wrapper.unmount();
  });

  it('focuses the composer after starting a new chat', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement;
    await wrapper.find('button.secondary-btn').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(textarea);
    wrapper.unmount();
  });

  it('submits composer on Enter and keeps focus on the composer', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    await wrapper.find('select').setValue('chat-1');
    await flushPromises();
    const textarea = wrapper.find('textarea');
    await textarea.setValue('please inspect');
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });
    await flushPromises();
    expect(sendChatMessage).toHaveBeenCalledWith('chat-1', 'please inspect');
    expect(document.activeElement).toBe(textarea.element);
    wrapper.unmount();
  });

  it('does not fetch messages for a fresh unsaved new chat and shows empty state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    getChatMessages.mockClear();
    await wrapper.find('button.secondary-btn').trigger('click');
    await flushPromises();
    expect(getChatMessages).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('No messages yet. Ask the analyst something.');
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('');
    wrapper.unmount();
  });

  it('renders a pending analyst tool chip before persisted messages catch up', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    const store = useAnalystChat();
    await store.selectSession('chat-1');
    store.ingestWsEvent({ event: 'analyst_tool_invoked', sessionId: 'chat-1', tool: 'read_file', summary: 'opened docs', success: true });
    await flushPromises();

    expect(wrapper.text()).toContain('🔧 read_file — opened docs');
    wrapper.unmount();
  });
});
