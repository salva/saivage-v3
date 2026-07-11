import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';

import DebugView from '../views/DebugView.vue';
import { useDebugStore } from '../stores/debug';
import type { AgentConversationResponse, AgentSession } from '../api/types';

const liveSyncMock = vi.hoisted(() => ({
  registerResource: vi.fn(() => vi.fn()),
  openConversation: vi.fn<(sessionId: string, refetch: () => Promise<void>) => () => void>(),
  unregisters: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock('../stores/liveSync', () => ({
  useLiveSyncStore: () => ({
    registerResource: liveSyncMock.registerResource,
    openConversation: liveSyncMock.openConversation,
  }),
}));

vi.mock('../api/client', () => ({
  getDebugState: vi.fn().mockResolvedValue({ runtime: null, cards: [], totalCards: 0 }),
  getDebugErrors: vi.fn().mockResolvedValue({ errors: [], total: 0 }),
  getDebugTimeline: vi.fn().mockResolvedValue({ events: [], total: 0 }),
  getDoctor: vi.fn().mockResolvedValue({ status: 'ok', checks: [], issues: [] }),
  getDebugSupervision: vi.fn().mockResolvedValue({ reviews: [], stats: null }),
  listProcesses: vi.fn().mockResolvedValue({ processes: [] }),
  listAgentSessions: vi.fn().mockResolvedValue({ sessions: [makeSession('session-a'), makeSession('session-b')] }),
  listFiles: vi.fn().mockResolvedValue({ files: [] }),
  getAgentConversation: vi.fn(async (sessionId: string) => makeConversation(makeSession(sessionId), `entry-${sessionId}`)),
  getAgentLlmExchange: vi.fn().mockResolvedValue({ entries: [] }),
  getFileContent: vi.fn().mockResolvedValue({ content: '' }),
  getMcpTools: vi.fn().mockResolvedValue({ tools: [], stats: {}, serverDetails: [] }),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

function makeSession(id: string): AgentSession {
  return {
    id,
    role: id.endsWith('b') ? 'executor' : 'planner',
    status: 'active',
    goal_card_id: 'goal-1',
    card_id: 'card-1',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    model: 'test-model',
  };
}

function makeConversation(session: AgentSession, entryId: string): AgentConversationResponse {
  return {
    session,
    entries: [{
      id: entryId,
      session_id: session.id,
      role: 'assistant',
      kind: 'text',
      content: entryId,
      round_id: 'r-assistant-00000000000000000000000000000001',
      message_index: 0,
      block_index: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
    }],
    activity_status: { status: 'idle', pending_calls: [], updated_at: '2026-01-01T00:00:00.000Z' },
  };
}

async function mountDebugView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/debug', name: 'debug', component: DebugView },
      { path: '/files', name: 'files', component: { template: '<div>Files</div>' } },
    ],
  });
  await router.push('/debug');
  await router.isReady();
  const wrapper = mount(DebugView, {
    global: {
      plugins: [pinia, router],
      stubs: { CodeBlock: true, ConversationTimeline: true, ViewState: true, StatusBanner: true, StatusBadge: true },
    },
  });
  await flushPromises();
  return { wrapper, store: useDebugStore() };
}

async function openAgentsTab(wrapper: ReturnType<typeof mount>) {
  const agentsTab = wrapper.findAll('.debug-tab-button').find((button) => button.text() === 'Agents');
  expect(agentsTab).toBeTruthy();
  await agentsTab!.trigger('click');
  await flushPromises();
}

describe('DebugView agent conversation live subscription', () => {
  beforeEach(() => {
    liveSyncMock.registerResource.mockClear();
    liveSyncMock.openConversation.mockReset();
    liveSyncMock.unregisters = [];
    liveSyncMock.openConversation.mockImplementation(() => {
      const unregister = vi.fn();
      liveSyncMock.unregisters.push(unregister);
      return unregister;
    });
  });

  it('opens the selected conversation subscription and closes it on session, kind, tab, and unmount changes', async () => {
    const { wrapper, store } = await mountDebugView();

    await openAgentsTab(wrapper);

    expect(liveSyncMock.openConversation).toHaveBeenLastCalledWith('session-a', expect.any(Function));
    const refetch = liveSyncMock.openConversation.mock.calls.at(-1)?.[1];
    expect(refetch).toBeTypeOf('function');
    const refetchSpy = vi.spyOn(store, 'refetchSelectedAgentDebugConversation').mockResolvedValue(undefined);
    await refetch!();
    expect(refetchSpy).toHaveBeenCalledTimes(1);

    store.selectAgentDebugSession('session-b');
    await flushPromises();
    expect(liveSyncMock.unregisters[0]).toHaveBeenCalledTimes(1);
    expect(liveSyncMock.openConversation).toHaveBeenLastCalledWith('session-b', expect.any(Function));
    const afterSessionChangeOpenCount = liveSyncMock.openConversation.mock.calls.length;

    store.selectedAgentDebugKind = 'llmExchange';
    await flushPromises();
    expect(liveSyncMock.unregisters[1]).toHaveBeenCalledTimes(1);
    expect(liveSyncMock.openConversation).toHaveBeenCalledTimes(afterSessionChangeOpenCount);

    store.selectedAgentDebugKind = 'conversation';
    await flushPromises();
    expect(liveSyncMock.openConversation).toHaveBeenLastCalledWith('session-b', expect.any(Function));
    const tabSubscription = liveSyncMock.unregisters.at(-1)!;

    const stateTab = wrapper.findAll('.debug-tab-button').find((button) => button.text() === 'State');
    expect(stateTab).toBeTruthy();
    await stateTab!.trigger('click');
    await flushPromises();
    expect(tabSubscription).toHaveBeenCalledTimes(1);

    await openAgentsTab(wrapper);
    const unmountSubscription = liveSyncMock.unregisters.at(-1)!;
    wrapper.unmount();
    expect(unmountSubscription).toHaveBeenCalledTimes(1);
  });
});
