import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnalystChat } from '../../stores/analystChat';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import type { AgentConversationEntry } from '../../api/types';

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
    apiMocks.listChatSessions.mockResolvedValue({ sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', started_at: '2025-01-01T00:00:00Z' }] });
    apiMocks.getChatEntries.mockResolvedValue({ sessionId: 'analyst:global', entries: [] as AgentConversationEntry[] });
    apiMocks.sendChatMessage.mockResolvedValue({
      sessionId: 'analyst:global',
      toolInvocations: [],
      restart: null,
    });
  });

  it('sends a third API arg mirroring the workspace route snapshot', async () => {
    const workspaceRoute = useWorkspaceRouteStore();
    workspaceRoute.view = 'cards';
    workspaceRoute.entityId = '11111111-1111-4111-8111-111111111111';
    workspaceRoute.refinement = { tab: 'history' };
    const chat = useAnalystChat();
    chat.activeSessionId = 'analyst:global';
    chat.setDraft('what is this?');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('analyst:global', 'what is this?', { view: 'cards', entityId: '11111111-1111-4111-8111-111111111111', refinement: { tab: 'history' } });
  });

  it('sends the deterministic null workspace context at the default route state', async () => {
    const chat = useAnalystChat();
    chat.activeSessionId = 'analyst:global';
    chat.setDraft('hello');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('analyst:global', 'hello', { view: null, entityId: null, refinement: null });
  });

  it('dispatches a successful navigate_workspace invocation with the full data payload', async () => {
    const target = { kind: 'card' as const, id: '22222222-2222-4222-8222-222222222222' };
    const payload = { intent: 'navigate_workspace' as const, target };
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: 'analyst:global',
      toolInvocations: [{ tool: 'navigate_workspace', params: {}, result: { success: true, data: payload } }],
      restart: null,
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.activeSessionId = 'analyst:global';
    chat.setDraft('open this card');
    await chat.sendMessage();
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(payload);
  });

  it('does not dispatch failed navigation invocations', async () => {
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      sessionId: 'analyst:global',
      toolInvocations: [{ tool: 'navigate_back', params: {}, result: { success: false, error: 'denied' } }],
      restart: null,
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.activeSessionId = 'analyst:global';
    chat.setDraft('go back');
    await chat.sendMessage();
    expect(applySpy).not.toHaveBeenCalled();
  });
});
