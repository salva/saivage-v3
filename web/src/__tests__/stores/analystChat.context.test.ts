import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnalystChat } from '../../stores/analystChat';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import type { ConversationEntry } from '../../api/types';

const apiMocks = vi.hoisted(() => ({
  listChatSessions: vi.fn(),
  getChatEntries: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  listChatSessions: apiMocks.listChatSessions,
  getChatEntries: apiMocks.getChatEntries,
  sendChatMessage: apiMocks.sendChatMessage,
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

describe('analyst chat workspace context', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    setActivePinia(createPinia());
    apiMocks.listChatSessions.mockReset();
    apiMocks.getChatEntries.mockReset();
    apiMocks.sendChatMessage.mockReset();
    apiMocks.listChatSessions.mockResolvedValue({ sessions: [{ id: 'analyst', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    apiMocks.getChatEntries.mockResolvedValue({ sessionId: 'analyst', entries: [] as ConversationEntry[] });
    apiMocks.sendChatMessage.mockResolvedValue({
      sessionId: 'analyst',
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
    chat.activeSessionId = 'analyst';
    chat.setDraft('what is this?');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('analyst', 'what is this?', { view: 'cards', entityId: 'card-9', refinement: { tab: 'history' } });
  });

  it('sends the deterministic null workspace context at the default route state', async () => {
    const chat = useAnalystChat();
    chat.activeSessionId = 'analyst';
    chat.setDraft('hello');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('analyst', 'hello', { view: null, entityId: null, refinement: null });
  });

  it('dispatches a successful navigate_workspace invocation with the full data payload', async () => {
    const target = { kind: 'card' as const, id: 'card-5' };
    const payload = { intent: 'navigate_workspace' as const, target };
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: 'analyst',
      message: { id: 'm1', content: 'reply', timestamp: '2025-01-01T00:00:00Z' },
      toolInvocations: [{ tool: 'navigate_workspace', params: {}, result: { success: true, data: payload } }],
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.activeSessionId = 'analyst';
    chat.setDraft('open this card');
    await chat.sendMessage();
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(payload);
  });

  it('does not dispatch failed navigation invocations', async () => {
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: 'analyst',
      message: { id: 'm1', content: 'reply', timestamp: '2025-01-01T00:00:00Z' },
      toolInvocations: [{ tool: 'navigate_back', params: {}, result: { success: false, error: 'denied' } }],
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.activeSessionId = 'analyst';
    chat.setDraft('go back');
    await chat.sendMessage();
    expect(applySpy).not.toHaveBeenCalled();
  });
});
