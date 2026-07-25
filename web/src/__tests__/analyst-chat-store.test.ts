import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnalystChat } from '../stores/analystChat';
import { useFeedbackStore } from '../stores/feedback';
import type { AgentConversationEntry, AgentConversationResponse } from '../api/types';

const analystSessionId = 'agent:analyst:global' as const;

const apiMocks = vi.hoisted(() => ({
  getChatEntries: vi.fn(),
  getAgentSession: vi.fn(),
  getAgentConversation: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock('../api/client', () => ({
  getChatEntries: apiMocks.getChatEntries,
  getAgentSession: apiMocks.getAgentSession,
  getAgentConversation: apiMocks.getAgentConversation,
  sendChatMessage: apiMocks.sendChatMessage,
  ApiError: class extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.body = body;
    }
    get isUnauthorized() {
      return this.status === 401;
    }
  },
}));

function entry(overrides: Partial<AgentConversationEntry>): AgentConversationEntry {
  return {
    id: 'entry-1',
    session_id: analystSessionId,
    role: 'user',
    kind: 'text',
    content: 'message',
    round_id: 'r-user-00000000000000000000000000000001',
    message_index: 0,
    block_index: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function chat(entries: AgentConversationEntry[] = []) {
  return { session_id: analystSessionId, entries, cursor: entries.at(-1)?.id ?? 'empty' };
}

describe('analyst chat store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    setActivePinia(createPinia());
    apiMocks.getChatEntries.mockReset();
    apiMocks.getAgentSession.mockReset();
    apiMocks.getAgentConversation.mockReset();
    apiMocks.sendChatMessage.mockReset();
    apiMocks.getChatEntries.mockResolvedValue({ session_id: analystSessionId });
    apiMocks.getAgentSession.mockResolvedValue({
      session: {
        id: analystSessionId,
        agent_name: 'analyst',
        session_scope: 'global',
        card_id: null,
        started_at: '2025-01-01T00:00:00Z',
      },
    });
    apiMocks.getAgentConversation.mockResolvedValue(chat());
    apiMocks.sendChatMessage.mockResolvedValue({
      sessionId: analystSessionId,
      toolInvocations: [],
      restart: null,
    });
    useAnalystChat().activeSessionId = analystSessionId;
  });

  it('createNewChat resolves to the canonical analyst session', async () => {
    const store = useAnalystChat();
    const sessionId = store.createNewChat();
    expect(sessionId).toBe(analystSessionId);
    expect(store.activeSessionId).toBe(analystSessionId);
    expect(store.messagesError).toBeNull();
  });

  it('does not refresh transcript from analyst tool activity frames', async () => {
    const store = useAnalystChat();
    await store.fetchMessages();
    apiMocks.getAgentConversation.mockClear();

    store.ingestWsEvent({
      event: 'analyst_tool_invoked',
      sessionId: analystSessionId,
      tool: 'list_cards',
      summary: 'listed cards',
      success: true,
    });

    expect(apiMocks.getAgentConversation).not.toHaveBeenCalled();
  });

  it('fetches the fixed singleton Analyst chat without a session argument', async () => {
    const store = useAnalystChat();

    store.activeSessionId = null;
    await store.fetchMessages();

    expect(apiMocks.getChatEntries).toHaveBeenLastCalledWith(expect.any(AbortSignal));
    expect(store.activeSessionId).toBe(analystSessionId);
  });

  it('retains the exact durable Analyst summary from the detail resource', async () => {
    const store = useAnalystChat();
    await store.fetchMessages();
    expect(store.activeSession).toEqual({
      id: analystSessionId,
      agent_name: 'analyst',
      session_scope: 'global',
      card_id: null,
      started_at: '2025-01-01T00:00:00Z',
    });
  });

  it('keeps sending as transport-only state without fabricating detail activity', async () => {
    const pending = deferred<any>();
    apiMocks.sendChatMessage.mockReturnValueOnce(pending.promise);
    const store = useAnalystChat();
    store.setDraft('question');
    const send = store.sendMessage();
    expect(store.sending).toBe(true);
    expect(store.activeSession).toBeNull();
    pending.resolve({ sessionId: analystSessionId, toolInvocations: [], restart: null });
    await send;
  });

  it('preserves API entry order when fetching messages', async () => {
    const first = entry({
      id: 'newer-api-first',
      content: 'first in API response',
      timestamp: '2026-01-01T00:00:03.000Z',
    });
    const second = entry({
      id: 'older-api-second',
      content: 'second in API response',
      timestamp: '2026-01-01T00:00:01.000Z',
      round_id: 'r-user-00000000000000000000000000000002',
    });
    apiMocks.getAgentConversation.mockResolvedValueOnce(chat([first, second]));

    const store = useAnalystChat();
    await store.fetchMessages();

    expect(store.messages.map((message) => message.id)).toEqual([first.id, second.id]);
  });

  it('does not refresh transcript from card or control activity frames', async () => {
    const store = useAnalystChat();
    await store.fetchMessages();
    apiMocks.getAgentConversation.mockClear();

    store.ingestWsEvent({ event: 'card_history_appended', sessionId: analystSessionId });
    store.ingestWsEvent({
      event: 'control_action_recorded',
      sessionId: analystSessionId,
      actor: 'analyst',
      surface: 'web-chat',
      action: 'approved',
      target_id: '11111111-1111-4111-8111-111111111111',
    });

    expect(apiMocks.getAgentConversation).not.toHaveBeenCalled();
  });

  it('presents a confirmation-required response without adding a status transcript entry', async () => {
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: analystSessionId,
      toolInvocations: [],
      restart: { status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' },
    });
    const store = useAnalystChat();
    store.setDraft('restart it');

    await store.sendMessage();

    expect(store.restartAcknowledgement).toEqual({
      status: 'confirmation_required',
      confirmationMessage: 'RESTART SERVER',
    });
    expect(store.messages.map((message) => message.content)).toEqual(['restart it']);
  });

  it.each([
    ['rejection', new Error('network down')],
    ['abort', new DOMException('Aborted', 'AbortError')],
  ])('retains confirmation acknowledgement on a response-less %s', async (_name, error) => {
    const store = useAnalystChat();
    store.ingestRestartAcknowledgement({
      status: 'confirmation_required',
      confirmationMessage: 'RESTART SERVER',
    });
    store.setDraft('RESTART SERVER');
    apiMocks.sendChatMessage.mockRejectedValueOnce(error);

    await expect(store.sendMessage()).rejects.toThrow();

    expect(store.restartAcknowledgement).toEqual({
      status: 'confirmation_required',
      confirmationMessage: 'RESTART SERVER',
    });
    expect(store.draft).toBe('RESTART SERVER');
    expect(store.messages).toEqual([]);
  });

  it('updates confirmation state only after a successful response consumes the next turn', async () => {
    const store = useAnalystChat();
    store.ingestRestartAcknowledgement({
      status: 'confirmation_required',
      confirmationMessage: 'RESTART SERVER',
    });
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: analystSessionId,
      toolInvocations: [],
      restart: null,
    });
    store.setDraft('not the phrase');

    await store.sendMessage();

    expect(store.restartAcknowledgement).toBeNull();
  });

  it('preserves the scheduled acknowledgement and optimistic confirmation when shutdown interrupts refetch', async () => {
    const store = useAnalystChat();
    store.ingestRestartAcknowledgement({
      status: 'confirmation_required',
      confirmationMessage: 'RESTART SERVER',
    });
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: analystSessionId,
      toolInvocations: [],
      restart: { status: 'scheduled' },
    });
    apiMocks.getAgentConversation.mockRejectedValueOnce(new Error('server shutting down'));
    store.setDraft('RESTART SERVER');

    await store.sendMessage();

    expect(store.restartAcknowledgement).toBeNull();
    expect(store.draft).toBe('');
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].content).toBe('RESTART SERVER');
    expect(store.sendError).toBeNull();
    expect(useFeedbackStore().toasts).toContainEqual(
      expect.objectContaining({
        tone: 'warning',
        title: 'Server restart scheduled',
        message:
          'The server is shutting down. This does not confirm that a replacement is running.',
      }),
    );
  });

  it('retains a consumed acknowledgement when a non-scheduled response refetch fails', async () => {
    const store = useAnalystChat();
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: analystSessionId,
      toolInvocations: [],
      restart: { status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' },
    });
    apiMocks.getAgentConversation.mockRejectedValueOnce(new Error('refetch failed'));
    store.setDraft('restart it');

    await expect(store.sendMessage()).resolves.toBeUndefined();

    expect(store.restartAcknowledgement).toEqual({
      status: 'confirmation_required',
      confirmationMessage: 'RESTART SERVER',
    });
    expect(store.sendError).toBeNull();
    expect(store.messagesError?.message).toBe('refetch failed');
    expect(store.messages.map((message) => message.content)).toEqual(['restart it']);
  });

  it('retains pending rows through stale and failed normal refreshes', async () => {
    const stale = deferred<AgentConversationResponse>();
    apiMocks.getAgentConversation.mockReturnValueOnce(stale.promise);
    const store = useAnalystChat();
    const staleFetch = store.fetchMessages();
    store.setDraft('pending');
    await store.sendMessage();
    expect(store.messages.map((message) => message.content)).toEqual(['pending']);

    stale.resolve(chat());
    await staleFetch;
    expect(store.messages.map((message) => message.content)).toEqual(['pending']);

    apiMocks.getAgentConversation.mockRejectedValueOnce(new Error('refresh failed'));
    await expect(store.fetchMessages()).rejects.toThrow('refresh failed');
    expect(store.messages.map((message) => message.content)).toEqual(['pending']);

    const accepted = entry({ id: 'accepted-later', content: 'pending' });
    apiMocks.getAgentConversation.mockResolvedValueOnce(chat([accepted]));
    await store.fetchMessages();
    expect(store.messages).toEqual([accepted]);
  });

  it('aborts superseded exact message requests', () => {
    apiMocks.getAgentConversation.mockReturnValue(new Promise(() => {}));
    const store = useAnalystChat();
    void store.fetchMessages();
    const firstMessageSignal = apiMocks.getAgentConversation.mock.calls[0][1] as AbortSignal;
    void store.fetchMessages();
    expect(firstMessageSignal.aborted).toBe(true);
  });

  it('reconciles an accepted send only when an authoritative row proves it', async () => {
    const store = useAnalystChat();
    store.setDraft('accepted');
    apiMocks.getAgentConversation.mockResolvedValueOnce(chat());
    await store.sendMessage();
    expect(store.messages.map((message) => message.content)).toEqual(['accepted']);

    const accepted = entry({ id: 'server-user', content: 'accepted' });
    apiMocks.getAgentConversation.mockResolvedValueOnce(chat([accepted]));
    await store.fetchMessages();
    expect(store.messages).toEqual([accepted]);
  });

  it('lets the newest normal or send-owned refresh win in either request order', async () => {
    const store = useAnalystChat();
    const normalFirst = deferred<AgentConversationResponse>();
    apiMocks.getAgentConversation.mockReturnValueOnce(normalFirst.promise);
    const oldNormal = store.fetchMessages();
    store.setDraft('one');
    await store.sendMessage();
    normalFirst.resolve(chat([entry({ id: 'stale', content: 'stale' })]));
    await oldNormal;
    expect(store.messages.map((message) => message.content)).toEqual(['one']);

    const sendRefresh = deferred<AgentConversationResponse>();
    apiMocks.getAgentConversation.mockReturnValueOnce(sendRefresh.promise);
    store.setDraft('two');
    const send = store.sendMessage();
    await vi.waitFor(() => expect(apiMocks.getAgentConversation).toHaveBeenCalledTimes(3));
    apiMocks.getAgentConversation.mockResolvedValueOnce(
      chat([entry({ id: 'new', content: 'newest' })]),
    );
    await store.fetchMessages();
    sendRefresh.resolve(chat([entry({ id: 'old', content: 'old' })]));
    await send;
    expect(store.messages.map((message) => message.content)).toEqual(['newest', 'one', 'two']);
  });

  it('ignores a superseded initial error delivered after abort and preserves the newer complete tuple', async () => {
    const store = useAnalystChat();
    const initial = deferred<AgentConversationResponse>();
    apiMocks.getAgentConversation.mockReturnValueOnce(initial.promise);
    const old = store.fetchMessages();
    const newest = entry({ id: 'newest-after-abort', content: 'newest' });
    apiMocks.getAgentConversation.mockResolvedValueOnce(chat([newest]));
    await store.fetchMessages();
    initial.reject(new Error('late initial failure'));
    await expect(old).resolves.toBeUndefined();
    expect(store.messages).toEqual([newest]);
    expect(store.activeSessionId).toBe(analystSessionId);
    expect(store.messagesError).toBeNull();
    expect(store.messagesLoading).toBe(false);
  });

  it('isolates send failure cleanup and restores its draft only when unchanged', async () => {
    const store = useAnalystChat();
    const sendFailure = deferred<never>();
    apiMocks.sendChatMessage.mockReturnValueOnce(sendFailure.promise);
    store.setDraft('failed send');
    const send = store.sendMessage();
    store.setDraft('new edit');
    const authoritative = entry({ id: 'server-existing', content: 'existing' });
    apiMocks.getAgentConversation.mockResolvedValueOnce(chat([authoritative]));
    await store.fetchMessages();
    sendFailure.reject(new Error('send failed'));
    await expect(send).rejects.toThrow('send failed');
    expect(store.draft).toBe('new edit');
    expect(store.messages).toEqual([authoritative]);

    apiMocks.sendChatMessage.mockRejectedValueOnce(new Error('again'));
    store.setDraft('restore me');
    await expect(store.sendMessage()).rejects.toThrow('again');
    expect(store.draft).toBe('restore me');
    expect(store.messages).toEqual([authoritative]);
  });
});
