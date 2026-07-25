import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AnalystChatPanel from '../components/chat/AnalystChatPanel.vue';
import { useCardStore } from '../stores/cards';

const analystSessionId = 'agent:analyst:global' as const;
const api = vi.hoisted(() => ({
  getChatEntries: vi.fn(),
  getAgentSession: vi.fn(),
  getAgentConversation: vi.fn(),
  getCardChildren: vi.fn(),
  sendChatMessage: vi.fn(),
}));
const live = vi.hoisted(() => ({ openConversation: vi.fn(), closeConversation: vi.fn() }));

vi.mock('../api/client', () => ({
  ...api,
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
      public body: Record<string, unknown> = {},
    ) {
      super(message);
    }
    get isUnauthorized() {
      return this.status === 401;
    }
  },
}));
vi.mock('../stores/liveSync', () => ({ useLiveSyncStore: () => live }));

const entries = [
  {
    id: '1',
    session_id: analystSessionId,
    role: 'assistant',
    kind: 'text',
    content: 'hello',
    round_id: 'r-assistant-00000000000000000000000000000001',
    message_index: 0,
    block_index: 0,
    timestamp: '2025-01-01T00:00:00Z',
  },
  {
    id: '2',
    session_id: analystSessionId,
    role: 'assistant',
    kind: 'tool_call',
    tool: 'read',
    tool_call_id: 'call-1',
    content: JSON.stringify({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) },
        },
      ],
    }),
    round_id: 'r-assistant-00000000000000000000000000000001',
    message_index: 1,
    block_index: 0,
    timestamp: '2025-01-01T00:00:01Z',
  },
  {
    id: '3',
    session_id: analystSessionId,
    role: 'tool',
    kind: 'tool_result',
    tool: 'read',
    tool_call_id: 'call-1',
    content: JSON.stringify({ success: true, data: { content: 'docs', total_lines: 1 } }),
    round_id: 'r-assistant-00000000000000000000000000000001',
    message_index: 2,
    block_index: 0,
    timestamp: '2025-01-01T00:00:02Z',
  },
] as const;

function mountPanel(pinia = createPinia()) {
  return mount(AnalystChatPanel, {
    attachTo: document.body,
    global: { plugins: [pinia] },
  });
}

describe('AnalystChatPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    api.getChatEntries.mockResolvedValue({ session_id: analystSessionId });
    api.getAgentSession.mockResolvedValue({
      session: {
        id: analystSessionId,
        agent_name: 'analyst',
        session_scope: 'global',
        card_id: null,
        started_at: '2025-01-01T00:00:00Z',
      },
    });
    api.getAgentConversation.mockResolvedValue({
      session_id: analystSessionId,
      entries,
      cursor: '3',
    });
    api.getCardChildren.mockResolvedValue({ card: { id: 'project' }, children: [] });
    api.sendChatMessage.mockResolvedValue({
      sessionId: analystSessionId,
      toolInvocations: [],
      restart: null,
    });
    live.openConversation.mockImplementation((_id, callback) => {
      void callback(null);
      return live.closeConversation;
    });
  });

  it('waits for root, loads identity, subscribes before transcript REST, and closes on unmount', async () => {
    let resolveRoot!: (value: unknown) => void;
    const pinia = createPinia();
    api.getCardChildren.mockReturnValue(new Promise((resolve) => (resolveRoot = resolve)));
    const existingRoot = useCardStore(pinia).ensureRoot();
    const wrapper = mountPanel(pinia);
    await flushPromises();
    expect(api.getChatEntries).not.toHaveBeenCalled();
    expect(live.openConversation).not.toHaveBeenCalled();

    resolveRoot({ card: { id: 'project' }, children: [] });
    await existingRoot;
    await flushPromises();
    expect(api.getChatEntries).toHaveBeenCalledTimes(1);
    expect(live.openConversation).toHaveBeenCalledWith(analystSessionId, expect.any(Function));
    expect(api.getAgentConversation).toHaveBeenCalledWith(
      analystSessionId,
      expect.any(AbortSignal),
      undefined,
    );
    wrapper.unmount();
    expect(live.closeConversation).toHaveBeenCalledTimes(1);
  });

  it('makes root settlement inert after unmount', async () => {
    let resolveRoot!: (value: unknown) => void;
    api.getCardChildren.mockReturnValue(new Promise((resolve) => (resolveRoot = resolve)));
    const wrapper = mountPanel();
    await flushPromises();
    wrapper.unmount();
    resolveRoot({ card: { id: 'project' }, children: [] });
    await flushPromises();
    expect(api.getChatEntries).not.toHaveBeenCalled();
    expect(live.openConversation).not.toHaveBeenCalled();
  });

  it('renders durable messages and tool chips with explicit expansion', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('hello');
    const chip = wrapper.find('.tool-chip');
    expect(chip.text()).toContain('Read');
    expect(chip.text()).toContain('README.md');
    await chip.find('button.tool-chip-toggle').trigger('click');
    expect(chip.find('button.tool-chip-toggle').attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('.tool-chip-body').exists()).toBe(true);
    wrapper.unmount();
  });

  it('gates the empty state while the acknowledged transcript baseline is loading', async () => {
    let resolveConversation!: (value: unknown) => void;
    api.getAgentConversation.mockReturnValue(
      new Promise((resolve) => (resolveConversation = resolve)),
    );
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('Loading history…');
    expect(wrapper.text()).not.toContain('No messages yet. Ask the analyst something.');
    resolveConversation({ session_id: analystSessionId, entries: [], cursor: 'empty' });
    await flushPromises();
    expect(wrapper.text()).toContain('No messages yet. Ask the analyst something.');
    wrapper.unmount();
  });

  it('renders one writable singleton without a session picker or new-chat control', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.find('button.secondary-btn').exists()).toBe(false);
    expect(wrapper.find('textarea').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('submits on Enter and retains focus on the composer', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const textarea = wrapper.get('textarea');
    await textarea.setValue('hello analyst');
    await textarea.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.sendChatMessage).toHaveBeenCalledWith('hello analyst', expect.any(Object));
    expect(document.activeElement).toBe(textarea.element);
    wrapper.unmount();
  });
});
