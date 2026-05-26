import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnalystChat } from '../../stores/analystChat';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import type { ChatMessage } from '../../api/types';

const apiMocks = vi.hoisted(() => ({
  listAgentSessions: vi.fn(),
  getChatMessages: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  listAgentSessions: apiMocks.listAgentSessions,
  getChatMessages: apiMocks.getChatMessages,
  sendChatMessage: apiMocks.sendChatMessage,
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

describe('analyst chat workspace context', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    setActivePinia(createPinia());
    apiMocks.listAgentSessions.mockReset();
    apiMocks.getChatMessages.mockReset();
    apiMocks.sendChatMessage.mockReset();
    apiMocks.listAgentSessions.mockResolvedValue({ sessions: [] });
    apiMocks.getChatMessages.mockResolvedValue({ sessionId: 'chat-1', messages: [] as ChatMessage[] });
    apiMocks.sendChatMessage.mockResolvedValue({
      sessionId: 'chat-1',
      message: { id: 'm1', content: 'reply', timestamp: '2025-01-01T00:00:00Z' },
      toolInvocations: [],
    });
  });

  it('sends a third API arg mirroring the workspace route snapshot', async () => {
    const workspaceRoute = useWorkspaceRouteStore();
    workspaceRoute.view = 'cards';
    workspaceRoute.entityId = 'card-9';
    workspaceRoute.refinement = { tab: 'history' };
    const chat = useAnalystChat();
    chat.activeSessionId = 'chat-1';
    chat.setDraft('what is this?');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('chat-1', 'what is this?', { view: 'cards', entityId: 'card-9', refinement: { tab: 'history' } });
  });

  it('sends the deterministic null workspace context at the default route state', async () => {
    const chat = useAnalystChat();
    chat.activeSessionId = 'chat-1';
    chat.setDraft('hello');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('chat-1', 'hello', { view: null, entityId: null, refinement: null });
  });

  it('dispatches a successful navigate_workspace invocation with the full data payload', async () => {
    const target = { kind: 'card' as const, id: 'card-5' };
    const payload = { intent: 'navigate_workspace' as const, target };
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: 'chat-1',
      message: { id: 'm1', content: 'reply', timestamp: '2025-01-01T00:00:00Z' },
      toolInvocations: [{ tool: 'navigate_workspace', params: {}, result: { success: true, data: payload } }],
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.activeSessionId = 'chat-1';
    chat.setDraft('open this card');
    await chat.sendMessage();
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(payload);
  });

  it('does not dispatch failed navigation invocations', async () => {
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: 'chat-1',
      message: { id: 'm1', content: 'reply', timestamp: '2025-01-01T00:00:00Z' },
      toolInvocations: [{ tool: 'navigate_back', params: {}, result: { success: false, error: 'denied' } }],
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.activeSessionId = 'chat-1';
    chat.setDraft('go back');
    await chat.sendMessage();
    expect(applySpy).not.toHaveBeenCalled();
  });
});
