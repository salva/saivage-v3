import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AnalystChatPanel from '../components/chat/AnalystChatPanel.vue';
import { useAnalystChat } from '../stores/analystChat';

const listAgentSessions = vi.fn();
const getChatMessages = vi.fn();
const sendChatMessage = vi.fn();

vi.mock('../api/client', () => ({
  listAgentSessions: (...args: any[]) => listAgentSessions(...args),
  getChatMessages: (...args: any[]) => getChatMessages(...args),
  sendChatMessage: (...args: any[]) => sendChatMessage(...args),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

describe('AnalystChatPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.useRealTimers();
    listAgentSessions.mockReset();
    getChatMessages.mockReset();
    sendChatMessage.mockReset();
    listAgentSessions.mockResolvedValue({ sessions: [{ id: 'chat-1', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    getChatMessages.mockResolvedValue({
      sessionId: 'chat-1',
      messages: [
        { id: '1', session_id: 'chat-1', role: 'assistant', kind: 'text', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
        { id: '2', session_id: 'chat-1', role: 'assistant', kind: 'tool_call', content: JSON.stringify({ toolCalls: [{ id: 'call-1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }), timestamp: '2025-01-01T00:00:01Z' },
        { id: '3', session_id: 'chat-1', role: 'tool', kind: 'tool_result', tool: 'read_file', tool_call_id: 'call-1', content: JSON.stringify({ ok: true, content: 'docs' }), timestamp: '2025-01-01T00:00:02Z' },
      ],
    });
    sendChatMessage.mockResolvedValue({ sessionId: 'chat-1', message: { id: '4', content: 'reply', timestamp: '2025-01-01T00:00:03Z' } });
  });


  it('shows Loading history… during initial fetch and gates empty state until loading completes', async () => {
    let resolveMessages: (value: any) => void = () => {};
    getChatMessages.mockReturnValueOnce(new Promise((resolve) => { resolveMessages = resolve; }));
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    await wrapper.find('select').setValue('chat-1');
    await flushPromises();
    expect(wrapper.text()).toContain('Loading history…');
    expect(wrapper.text()).not.toContain('No messages yet. Ask the analyst something.');
    resolveMessages({ sessionId: 'chat-1', messages: [] });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Loading history…');
    expect(wrapper.text()).toContain('No messages yet. Ask the analyst something.');
    wrapper.unmount();
  });

  it('groups /api/agents sessions by role and disables composer for read-only agent sessions', async () => {
    listAgentSessions.mockResolvedValueOnce({ sessions: [
      { id: 'chat-1', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' },
      { id: 'planner:goal-1', role: 'planner', status: 'inactive', started_at: '2025-01-01T00:00:01Z' },
      { id: 'reviewer:goal-1', role: 'reviewer', status: 'inactive', started_at: '2025-01-01T00:00:02Z' },
      { id: 'executor:card-1', role: 'executor', status: 'inactive', started_at: '2025-01-01T00:00:03Z' },
      { id: 'card-card-1', role: 'analyst', status: 'inactive', started_at: '2025-01-01T00:00:04Z' },
    ] });
    getChatMessages.mockResolvedValue({ sessionId: 'planner:goal-1', messages: [] });
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    const labels = wrapper.findAll('optgroup').map((group) => group.attributes('label'));
    expect(labels).toEqual(['Analyst', 'Card discussions', 'Planner', 'Reviewer', 'Executor']);
    await wrapper.find('select').setValue('planner:goal-1');
    await flushPromises();
    const textarea = wrapper.find('textarea');
    expect(textarea.attributes('disabled')).toBeDefined();
    expect(textarea.attributes('title')).toBe('Read-only — switch to analyst to send messages');
    expect(wrapper.find('button.primary-btn').attributes('title')).toBe('Read-only — switch to analyst to send messages');
    wrapper.unmount();
  });

  it('renders messages and tool chips with expand/collapse', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    await wrapper.find('select').setValue('chat-1');
    await flushPromises();
    expect(wrapper.text()).toContain('hello');
    const chips = wrapper.findAll('.tool-chip');
    expect(chips[0].text()).toContain('🔧 read_file');
    expect(chips[0].text()).toContain('README.md');
    expect(chips[0].attributes('aria-expanded')).toBe('false');
    await chips[0].trigger('click');
    expect(chips[0].attributes('aria-expanded')).toBe('true');
    expect(chips[0].attributes('aria-label')).toContain('Collapse analyst tool call details');
    expect(wrapper.find('.tool-chip-detail').text()).toContain('README.md');
    await chips[0].trigger('click');
    expect(wrapper.find('.tool-chip-detail').exists()).toBe(false);
    wrapper.unmount();
  });


  it('renders tool result messages as human-readable status labels with raw details', async () => {
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [createPinia()] } });
    await flushPromises();
    await wrapper.find('select').setValue('chat-1');
    await flushPromises();
    const chips = wrapper.findAll('.tool-chip');
    expect(chips[1].text()).toContain('📤 read_file → ok');
    expect(chips[1].text()).toContain('docs');
    await chips[1].trigger('click');
    expect(wrapper.find('.tool-chip-detail').text()).toContain('"ok": true');
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

  it('renders classified_as and related-card attribution for pending chips from sanitized events', async () => {
    const pinia = createPinia();
    const wrapper = mount(AnalystChatPanel, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    const store = useAnalystChat();
    await store.selectSession('chat-1');
    store.ingestWsEvent({
      event: 'analyst_tool_invoked',
      session_id: 'chat-1',
      tool: 'run_shell_command',
      summary: '[SECRET_PATH] redacted preview',
      classified_as: 'destructive',
      related_card_id: 'card-7',
      success: true,
    });
    await flushPromises();

    expect(wrapper.text()).toContain('run_shell_command');
    expect(wrapper.text()).toContain('[SECRET_PATH] redacted preview');
    expect(wrapper.text()).toContain('destructive');
    expect(wrapper.text()).toContain('card card-7');
    wrapper.unmount();
  });
});
