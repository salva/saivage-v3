import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnalystChat } from '../../stores/analystChat';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import type { AgentConversationEntry } from '../../api/types';

const apiMocks = vi.hoisted(() => ({
  getChatEntries: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  getChatEntries: apiMocks.getChatEntries,
  sendChatMessage: apiMocks.sendChatMessage,
}));

describe('analyst chat workspace context', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    setActivePinia(createPinia());
    apiMocks.getChatEntries.mockReset();
    apiMocks.sendChatMessage.mockReset();
    apiMocks.getChatEntries.mockResolvedValue({ session_id: 'agent:analyst:global' });
    apiMocks.sendChatMessage.mockResolvedValue({
      toolInvocations: [],
      restart: null,
    });
  });

  it('sends workspace context beside content without an Analyst identity argument', async () => {
    const workspaceRoute = useWorkspaceRouteStore();
    workspaceRoute.view = 'cards';
    workspaceRoute.entityId = '11111111-1111-4111-8111-111111111111';
    workspaceRoute.refinement = { tab: 'history' };
    const chat = useAnalystChat();
    chat.activeSessionId = 'agent:analyst:global';
    chat.setDraft('what is this?');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('what is this?', { view: 'cards', entityId: '11111111-1111-4111-8111-111111111111', refinement: { tab: 'history' } });
  });

  it('sends the deterministic null workspace context at the default route state', async () => {
    const chat = useAnalystChat();
    chat.activeSessionId = 'agent:analyst:global';
    chat.setDraft('hello');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('hello', { view: null, entityId: null, refinement: null });
  });

  it('dispatches a successful navigate_workspace invocation with the full data payload', async () => {
    const target = { kind: 'card' as const, id: '22222222-2222-4222-8222-222222222222' };
    const payload = { intent: 'navigate_workspace' as const, target };
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      toolInvocations: [{ tool: 'navigate_workspace', params: {}, result: { success: true, data: payload } }],
      restart: null,
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.activeSessionId = 'agent:analyst:global';
    chat.setDraft('open this card');
    await chat.sendMessage();
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(payload);
  });

  it('does not dispatch failed navigation invocations', async () => {
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      toolInvocations: [{ tool: 'navigate_back', params: {}, result: { success: false, error: 'denied' } }],
      restart: null,
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.activeSessionId = 'agent:analyst:global';
    chat.setDraft('go back');
    await chat.sendMessage();
    expect(applySpy).not.toHaveBeenCalled();
  });
});
