import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { nextTick, type Ref } from 'vue';
import AnalystChatPanel from '../components/chat/AnalystChatPanel.vue';
import { useCardStore } from '../stores/cards';
import { useAnalystChat } from '../stores/analystChat';
import { OperatorApiError } from '../api/client';
import { SyncClient, type ConversationInvalidation } from '../sync/client';
import type { WsConnectionManager, WsSyncFrameHandler } from '../api/websocket';

const analystSessionId = 'agent:analyst:global' as const;
const api = vi.hoisted(() => ({
  getChatEntries: vi.fn(),
  getAgentSession: vi.fn(),
  getAgentConversation: vi.fn(),
  getCardChildren: vi.fn(),
  sendChatMessage: vi.fn(),
}));
const live = vi.hoisted(() => ({
  connectionState: null as Ref<'connected' | 'connecting' | 'offline' | 'unauthorized'> | null,
  openConversation: vi.fn(),
  closeConversation: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  ...api,
}));
vi.mock('../stores/sync', async () => {
  const { ref } = await import('vue');
  live.connectionState = ref<'connected' | 'connecting' | 'offline' | 'unauthorized'>('connected');
  return {
    useSyncStore: () => ({
      get connectionState() {
        return live.connectionState!.value;
      },
      openConversation: live.openConversation,
    }),
  };
});

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
    content: JSON.stringify({ success: true, data: { total_bytes: 4, content: { content: 'docs', utf8_bytes: 4, offset_bytes: 0, next_offset_bytes: 4 } } }),
    round_id: 'r-assistant-00000000000000000000000000000001',
    message_index: 2,
    block_index: 0,
    timestamp: '2025-01-01T00:00:02Z',
  },
] as const;

function mountPanel(pinia = createPinia()) {
  const chat = useAnalystChat(pinia);
  if (chat.identityState.kind !== 'resolved') void chat.resolveIdentity();
  return mount(AnalystChatPanel, {
    attachTo: document.body,
    global: { plugins: [pinia] },
  });
}

describe('AnalystChatPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    live.connectionState!.value = 'connected';
    api.getChatEntries.mockResolvedValue({ session_id: analystSessionId });
    api.getAgentSession.mockResolvedValue({
      session: {
        id: analystSessionId,
        agent_name: 'analyst',
        session_scope: 'global',
        compaction: null,
        card_id: null,
        started_at: '2025-01-01T00:00:00Z',
        status: 'active', activity: 'busy',
      },
    });
    api.getAgentConversation.mockResolvedValue({
      session_id: analystSessionId,
      segment_version: 1,
      segment_context: null,
      entries,
      cursor: { segment_version: 1, message_id: '3' },
    });
    api.getCardChildren.mockResolvedValue({ parent: { id: 'project', type: 'project', title: 'Project', status: 'backlog', permitted_child_types: ['goal'] }, children: [] });
    api.sendChatMessage.mockResolvedValue({
      toolInvocations: [],
      restart: null,
    });
    live.openConversation.mockImplementation((_id, callback) => {
      void callback(null);
      return live.closeConversation;
    });
  });

  it('loads independently of delayed Cards, subscribes before transcript REST, and closes on unmount', async () => {
    let resolveRoot!: (value: unknown) => void;
    const pinia = createPinia();
    api.getCardChildren.mockReturnValue(new Promise((resolve) => (resolveRoot = resolve)));
    const existingRoot = useCardStore(pinia).ensureRoot();
    const wrapper = mountPanel(pinia);
    await flushPromises();
    expect(api.getChatEntries).toHaveBeenCalledTimes(1);
    expect(live.openConversation).toHaveBeenCalledWith(analystSessionId, expect.any(Function));
    expect(api.getAgentConversation).toHaveBeenCalledWith(
      analystSessionId,
      expect.any(AbortSignal),
      undefined,
    );

    resolveRoot({ parent: { id: 'project', type: 'project', title: 'Project', status: 'backlog', permitted_child_types: ['goal'] }, children: [] });
    await existingRoot;
    await flushPromises();
    expect(api.getChatEntries).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    expect(live.closeConversation).toHaveBeenCalledTimes(1);
  });

  it('reopens the unchanged conversation identity for each component lifetime', async () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    live.openConversation
      .mockImplementationOnce((_id, callback) => {
        void callback(null);
        return firstClose;
      })
      .mockImplementationOnce((_id, callback) => {
        void callback(null);
        return secondClose;
      });
    const pinia = createPinia();

    const firstPanel = mountPanel(pinia);
    await flushPromises();
    expect(api.getChatEntries).toHaveBeenCalledTimes(1);
    expect(live.openConversation).toHaveBeenCalledTimes(1);
    expect(live.openConversation).toHaveBeenNthCalledWith(
      1,
      analystSessionId,
      expect.any(Function),
    );

    firstPanel.unmount();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();

    const secondPanel = mountPanel(pinia);
    await flushPromises();
    expect(api.getChatEntries).toHaveBeenCalledTimes(1);
    expect(live.openConversation).toHaveBeenCalledTimes(2);
    expect(live.openConversation).toHaveBeenNthCalledWith(
      2,
      analystSessionId,
      expect.any(Function),
    );

    secondPanel.unmount();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it('never initiates Cards loading from the panel', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(api.getCardChildren).not.toHaveBeenCalled();
    wrapper.unmount();
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
    resolveConversation({ session_id: analystSessionId, segment_version: 1, segment_context: null, entries: [], cursor: { segment_version: 1, message_id: null } });
    await flushPromises();
    expect(wrapper.text()).toContain('No messages yet. Ask the analyst something.');
    wrapper.unmount();
  });

  it('distinguishes waiting for live sync from connected history loading', async () => {
    let callback!: (frame: ConversationInvalidation) => Promise<void>;
    live.connectionState!.value = 'offline';
    live.openConversation.mockImplementation((_id, value) => {
      callback = value;
      return live.closeConversation;
    });
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain('Waiting for live connection…');
    expect(wrapper.text()).not.toContain('Loading history…');
    expect(wrapper.find('.loading-skeleton').exists()).toBe(false);
    expect(api.getAgentConversation).not.toHaveBeenCalled();

    live.connectionState!.value = 'connected';
    await nextTick();
    expect(wrapper.text()).toContain('Loading history…');
    expect(wrapper.find('.loading-skeleton').exists()).toBe(true);

    await callback(null);
    await flushPromises();
    expect(wrapper.text()).not.toContain('Loading history…');
    expect(wrapper.text()).toContain('hello');
    wrapper.unmount();
  });

  it('directs an unauthorized initial transcript to Token without requesting it prematurely', async () => {
    live.connectionState!.value = 'unauthorized';
    live.openConversation.mockImplementation(() => live.closeConversation);
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain(
      'Live connection unauthorized. Open Token and save a valid API token to reconnect.',
    );
    expect(wrapper.text()).not.toContain('Waiting for live connection…');
    expect(wrapper.text()).not.toContain('Loading history…');
    expect(api.getAgentConversation).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('renders one singleton surface without a session picker or new-chat control', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.find('button.secondary-btn').exists()).toBe(false);
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

  it('renders the stable exact busy feedback in the existing send-error surface', async () => {
    const pinia = createPinia();
    const wrapper = mountPanel(pinia);
    await flushPromises();
    api.sendChatMessage.mockRejectedValueOnce(new OperatorApiError(
      'chats.send',
      409,
      {
        error: 'analyst_turn_busy',
        message: 'Another Analyst turn is active. Retry after it finishes.',
},));
    const chat = useAnalystChat(pinia);
    chat.setDraft('overlap');

    await expect(chat.sendMessage()).rejects.toThrow();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(
      'Another Analyst turn is active. Retry after it finishes.',
    );
    expect(chat.messages).toEqual(entries);
    expect(chat.draft).toBe('overlap');
    wrapper.unmount();
  });

  it('withholds direct, send-follow-up, and invalidation transcript reads until acknowledgement', async () => {
    let callback!: (frame: any) => Promise<void>;
    live.openConversation.mockImplementation((_id, value) => {
      callback = value;
      return live.closeConversation;
    });
    const pinia = createPinia();
    const wrapper = mountPanel(pinia);
    await flushPromises();
    const chat = useAnalystChat(pinia);
    expect(chat.messagesLoading).toBe(true);
    expect(api.getAgentConversation).not.toHaveBeenCalled();

    await chat.fetchMessages();
    chat.setDraft('pending before ack');
    await chat.sendMessage();
    await callback({ t: 'invalidate', resource: 'conversation', id: analystSessionId, segment_version: 1, visible_message_id: 'm1' });
    expect(api.getAgentConversation).not.toHaveBeenCalled();
    expect(chat.messages.map(({ content }) => content)).toEqual(['pending before ack']);

    api.getAgentConversation.mockResolvedValueOnce({
      session_id: analystSessionId,
      segment_version: 1,
      segment_context: null,
      entries: [{ ...entries[0], id: 'accepted-user', role: 'user', content: 'pending before ack' }],
      cursor: { segment_version: 1, message_id: 'accepted-user' },
    });
    await callback(null);
    expect(api.getAgentConversation).toHaveBeenCalledOnce();
    expect(chat.messages.map(({ id }) => id)).toEqual(['accepted-user']);
    wrapper.unmount();
  });

  it('keeps retained rows and refresh alert visible through unmount and unacknowledged remount', async () => {
    let firstCallback!: (frame: any) => Promise<void>;
    let secondCallback!: (frame: any) => Promise<void>;
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    live.openConversation
      .mockImplementationOnce((_id, callback) => {
        firstCallback = callback;
        void callback(null);
        return firstClose;
      })
      .mockImplementationOnce((_id, callback) => {
        secondCallback = callback;
        return secondClose;
      });
    const pinia = createPinia();
    const first = mountPanel(pinia);
    await flushPromises();
    const chat = useAnalystChat(pinia);
    api.getAgentConversation.mockRejectedValueOnce(new Error('retained refresh failure'));
    chat.setDraft('optimistic retained');
    await chat.sendMessage();
    await flushPromises();
    expect(first.text()).toContain('retained refresh failure');
    expect(first.text()).toContain('hello');
    expect(first.text()).toContain('optimistic retained');
    first.unmount();

    const requestCount = api.getAgentConversation.mock.calls.length;
    const second = mountPanel(pinia);
    await flushPromises();
    expect(api.getAgentConversation).toHaveBeenCalledTimes(requestCount);
    expect(second.text()).toContain('retained refresh failure');
    expect(second.text()).toContain('hello');
    expect(second.text()).toContain('optimistic retained');
    expect(second.text()).not.toContain('Loading history…');
    await firstCallback(null);
    expect(api.getAgentConversation).toHaveBeenCalledTimes(requestCount);

    let resolveRefresh!: (value: any) => void;
    api.getAgentConversation.mockReturnValueOnce(new Promise((resolve) => (resolveRefresh = resolve)));
    const refresh = secondCallback(null);
    await flushPromises();
    expect(api.getAgentConversation).toHaveBeenCalledTimes(requestCount + 1);
    expect(second.text()).not.toContain('retained refresh failure');
    expect(second.text()).not.toContain('Loading history…');
    expect(second.text()).toContain('hello');
    expect(second.text()).toContain('optimistic retained');
    resolveRefresh({ session_id: analystSessionId, segment_version: 1, segment_context: null, entries: [], cursor: { segment_version: 1, message_id: '3' } });
    await refresh;
    second.unmount();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it('joins an already-acknowledged real SyncClient conversation lease without another subscribe', async () => {
    let syncHandler: WsSyncFrameHandler = () => {};
    const sent: any[] = [];
    const conn = {
      state: { value: 'connected' as const },
      connect: vi.fn(),
      reconfigure: vi.fn(),
      sendRaw: vi.fn((frame) => { sent.push(frame); return true; }),
      onEvent: vi.fn(() => () => {}),
      onState: vi.fn(() => () => {}),
      onOpen: vi.fn(() => () => {}),
      onSyncFrame: vi.fn((handler) => { syncHandler = handler; return () => {}; }),
    } satisfies WsConnectionManager;
    const client = new SyncClient(conn);
    client.start();
    client.openConversation(analystSessionId, async () => undefined);
    const subscribe = sent[0];
    syncHandler({ t: 'subscribed', resource: 'conversation', id: analystSessionId, lease: subscribe.lease });
    await flushPromises();
    live.openConversation.mockImplementation((id, callback) => client.openConversation(id, callback));

    const wrapper = mountPanel();
    await flushPromises();
    expect(sent.filter((frame) => frame.t === 'subscribe')).toHaveLength(1);
    expect(api.getAgentConversation).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
