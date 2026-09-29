import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnalystChat } from '../../stores/analystChat';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';

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
  beforeEach(async () => {
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
    await useAnalystChat().resolveIdentity();
  });

  it('sends workspace context beside content without an Analyst identity argument', async () => {
    const workspaceRoute = useWorkspaceRouteStore();
    workspaceRoute.view = 'cockpit';
    workspaceRoute.entityId = '11111111-1111-4111-8111-111111111111';
    workspaceRoute.refinement = { tab: 'history' };
    const chat = useAnalystChat();
    chat.setDraft('what is this?');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('what is this?', { view: 'cockpit', entityId: '11111111-1111-4111-8111-111111111111', refinement: { tab: 'history' } });
  });

  it('sends the deterministic null workspace context at the default route state', async () => {
    const chat = useAnalystChat();
    chat.setDraft('hello');
    await chat.sendMessage();
    expect(apiMocks.sendChatMessage).toHaveBeenCalledWith('hello', { view: null, entityId: null, refinement: null });
  });

  it('captures a detached route and does not change the sent focus during an in-flight request', async () => {
    const route = useWorkspaceRouteStore();
    route.view = 'cockpit'; route.entityId = 'card-a'; route.refinement = { tab: 'history' };
    let release!: (value: { toolInvocations: []; restart: null }) => void;
    apiMocks.sendChatMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const chat = useAnalystChat(); chat.setDraft('this one');
    const sending = chat.sendMessage();
    const captured = apiMocks.sendChatMessage.mock.calls[0]![1];
    route.entityId = 'card-b'; route.refinement!.tab = 'other';
    expect(captured).toEqual({ view: 'cockpit', entityId: 'card-a', refinement: { tab: 'history' } });
    release({ toolInvocations: [], restart: null }); await sending;
  });

  it('retains the draft without sending when the captured UTF-8 route exceeds the limit', async () => {
    const route = useWorkspaceRouteStore(); route.view = 'files'; route.entityId = '🧭'.repeat(520);
    const chat = useAnalystChat(); chat.setDraft('inspect this');
    await expect(chat.sendMessage()).rejects.toThrow();
    expect(chat.draft).toBe('inspect this');
    expect(apiMocks.sendChatMessage).not.toHaveBeenCalled();
    expect(chat.sendError).not.toBeNull();
  });

  it('retains the draft on a server-side redaction budget rejection without retry', async () => {
    apiMocks.sendChatMessage.mockRejectedValueOnce(new Error('Workspace context cannot fit safely after redaction.'));
    const chat = useAnalystChat(); chat.setDraft('inspect this');
    await expect(chat.sendMessage()).rejects.toThrow('Workspace context cannot fit safely');
    expect(chat.draft).toBe('inspect this');
    expect(apiMocks.sendChatMessage).toHaveBeenCalledTimes(1);
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
    chat.setDraft('open this card');
    await chat.sendMessage();
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(payload);
  });

  it('dispatches a successful navigate_back invocation', async () => {
    const payload = { intent: 'navigate_back' as const };
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      toolInvocations: [{ tool: 'navigate_back', params: {}, result: { success: true, data: payload } }],
      restart: null,
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.setDraft('go back');
    await chat.sendMessage();
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
    chat.setDraft('go back');
    await chat.sendMessage();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('rejects malformed successful navigation after accepting the send and before applying it', async () => {
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      toolInvocations: [{ tool: 'navigate_workspace', params: {}, result: { success: true, data: { intent: 'navigate_workspace' } } }],
      restart: null,
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.setDraft('open a card');

    await expect(chat.sendMessage()).rejects.toThrow();

    expect(applySpy).not.toHaveBeenCalled();
    expect(chat.draft).toBe('');
    expect(chat.sendError).toBeNull();
    expect(chat.messages).toHaveLength(1);
  });

  it.each([
    ['navigate_workspace', { intent: 'navigate_back' }],
    ['navigate_back', { intent: 'navigate_workspace', target: { kind: 'process_list' } }],
  ] as const)('rejects cross-wired %s results before applying them', async (tool, data) => {
    apiMocks.sendChatMessage.mockResolvedValueOnce({
      toolInvocations: [{ tool, params: {}, result: { success: true, data } }],
      restart: null,
    });
    const workspaceRoute = useWorkspaceRouteStore();
    const applySpy = vi.spyOn(workspaceRoute, 'apply').mockImplementation(() => undefined);
    const chat = useAnalystChat();
    chat.setDraft('navigate');

    await expect(chat.sendMessage()).rejects.toThrow(`Navigation tool ${tool} returned ${data.intent} intent.`);
    expect(applySpy).not.toHaveBeenCalled();
  });
});
