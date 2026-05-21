import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from '../views/DashboardView.vue';
import type { ChatMessage, RuntimeState, CardIndex, ChatResponse } from '../api/types';

const _wsConnectionState = ref<string>('connected');
let _wsSessionIdVal: string | null = 'sess-dash-001';
let mockWsIsConnected = true;
const mockSendMessageCalls: string[] = [];
let wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();

function resetTestState() {
  _wsConnectionState.value = 'connected';
  _wsSessionIdVal = 'sess-dash-001';
  mockWsIsConnected = true;
  mockSendMessageCalls.length = 0;
  wsTypeHandlers = new Map();
}

vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    connectionState: _wsConnectionState,
    get sessionId() { return _wsSessionIdVal; },
    reconnectAttempts: ref(0),
    onType: (type: string, handler: (envelope: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) { set = new Set(); wsTypeHandlers.set(type, set); }
      set.add(handler);
      return () => { set?.delete(handler); };
    },
    onReconnect: vi.fn(() => () => {}),
    sendMessage: (text: string) => { mockSendMessageCalls.push(text); },
    isConnected: () => mockWsIsConnected,
    isConnecting: () => false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock('../api/client', () => {
  const ApiError = class extends Error {
    status: number; body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message); this.name = 'ApiError'; this.status = status; this.body = body;
    }
    get isUnauthorized(): boolean { return this.status === 401; }
  };
  return { listChatSessions: vi.fn(), getChatMessages: vi.fn(), sendChatMessage: vi.fn(), getRuntimeState: vi.fn(), pauseRuntime: vi.fn(), resumeRuntime: vi.fn(), ApiError };
});

import { listChatSessions, getChatMessages, sendChatMessage, getRuntimeState, ApiError } from '../api/client';

const mockPush = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  return { ...actual, useRouter: () => ({ push: mockPush, currentRoute: { value: { query: {} } } }) };
});

const mockChatSessions = { sessions: [{ id: 'chat-sess-1', role: 'analyst', status: 'active', started_at: '2025-06-01T10:00:00Z' }] };
const mockChatHistory: ChatMessage[] = [
  { id: 'msg-1', session_id: 'chat-sess-1', role: 'user', kind: 'text', content: 'Hello analyst!', timestamp: '2025-06-01T10:01:00Z' },
  { id: 'msg-2', session_id: 'chat-sess-1', role: 'assistant', kind: 'text', content: 'Hello! How can I help you today?', timestamp: '2025-06-01T10:01:05Z' },
];
const mockChatResponse: ChatResponse = {
  sessionId: 'chat-sess-1',
  message: { id: 'msg-3', session_id: 'chat-sess-1', role: 'assistant', kind: 'text', content: 'I have created **card-abc** for your request.', timestamp: '2025-06-01T10:02:00Z' },
};
const mockRuntimeState: RuntimeState = {
  status: 'running', project_id: 'saivage-v3', pid: 12345, started_at: '2025-06-01T08:00:00Z', current_card_id: 'card-001', current_agent_session_id: 'agent-sess-xyz', paused: false, paused_at: null, queue: ['card-002', 'card-003'], running_processes: ['proc-1'], updated_at: '2025-06-01T10:30:00Z',
};
const mockCardIndex: CardIndex = {
  total: 42, byStatus: { done: 30, failed: 3, blocked: 2, active: 5, backlog: 2 }, byType: { code: 20, test: 10, research: 5, goal: 3, doc: 4 },
};
const mockCardStoreHealthOk = { canonical: 'ok' as const, compatibilitySnapshots: 'ok' as const, lastCompatibilitySnapshotWarning: null, warnings: [] };
const mockCardStoreHealthDegraded = { canonical: 'ok' as const, compatibilitySnapshots: 'degraded' as const, lastCompatibilitySnapshotWarning: { code: 'compatibility-snapshot-degraded' as const, operation: 'startup-repair' as const, relativePath: '.saivage/cards/tree/project.children.json', message: 'Synthetic warning token=[REDACTED]', occurredAt: '2026-01-01T00:00:00.000Z', canonicalCommitted: false }, warnings: [] };
const mockRuntimeStateResponse = { runtime: mockRuntimeState, cardIndex: mockCardIndex };

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: { template: '<div>Dashboard</div>' } },
      { path: '/cards/:id', name: 'card-detail', component: { template: '<div>Card</div>' } },
      { path: '/agents/:id', name: 'agent-detail', component: { template: '<div>Agent</div>' } },
      { path: '/files', name: 'files', component: { template: '<div>Files</div>' } },
      { path: '/debug', name: 'debug', component: { template: '<div>Debug</div>' } },
    ],
  });
}

async function mountDashboard(opts?: { runtimeResponse?: any; chatSessionsResponse?: any; chatMessagesResponse?: any; keepWsState?: boolean; }) {
  if (!opts?.keepWsState) resetTestState();
  setActivePinia(createPinia());
  vi.mocked(listChatSessions).mockResolvedValue(opts?.chatSessionsResponse ?? mockChatSessions);
  vi.mocked(getChatMessages).mockResolvedValue({ sessionId: 'chat-sess-1', messages: opts?.chatMessagesResponse ?? mockChatHistory });
  vi.mocked(sendChatMessage).mockResolvedValue(mockChatResponse);
  vi.mocked(getRuntimeState).mockResolvedValue(opts?.runtimeResponse ?? mockRuntimeStateResponse);

  const router = makeRouter();
  const wrapper = mount(DashboardView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return wrapper;
}

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    resetTestState();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('uses LIVE badge and connected placeholder when websocket is connected', async () => {
    const w = await mountDashboard();
    expect(w.find('.session-badge.live').text()).toBe('LIVE');
    expect(w.find('.chat-input').attributes('placeholder')).toContain('Message the analyst');
  });

  it('shows reconnecting chat message when websocket is connecting', async () => {
    _wsConnectionState.value = 'connecting';
    mockWsIsConnected = false;
    const w = await mountDashboard({ keepWsState: true, chatSessionsResponse: { sessions: [] } });
    expect(w.find('.session-badge.connecting').text()).toBe('RECONNECTING');
    expect(w.find('.chat-status-banner').text()).toContain('reconnecting');
  });

  it('shows unauthorized chat message distinct from docs access', async () => {
    _wsConnectionState.value = 'unauthorized';
    mockWsIsConnected = false;
    const w = await mountDashboard({ keepWsState: true, chatSessionsResponse: { sessions: [] } });
    expect(w.find('.session-badge.unauthorized').text()).toBe('UNAUTHORIZED');
    expect(w.find('.chat-status-banner').text()).toContain('public docs at /docs/ do not require one');
  });

  it('does not try to bootstrap a chat session with an empty send when no sessions exist', async () => {
    const w = await mountDashboard({ chatSessionsResponse: { sessions: [] } });
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(w.find('.chat-empty').exists()).toBe(true);
  });

  it('sends websocket chat and clears loading when a websocket message arrives', async () => {
    const w = await mountDashboard();
    await w.find('.chat-input').setValue('Create a new card for testing');
    await w.find('.send-btn').trigger('click');
    await flushPromises();
    expect(mockSendMessageCalls).toContain('Create a new card for testing');

    for (const handler of wsTypeHandlers.get('message') ?? []) {
      handler({ type: 'message', content: mockChatResponse.message });
    }
    await flushPromises();
    expect(w.findAll('.chat-message.role-assistant').at(-1)?.text()).toContain('created');
  });

  it('surfaces websocket chat error frames as operator-visible status', async () => {
    const w = await mountDashboard();
    await w.find('.chat-input').setValue('Run diagnostics');
    await w.find('.send-btn').trigger('click');
    await flushPromises();
    for (const handler of wsTypeHandlers.get('error') ?? []) {
      handler({ type: 'error', content: { message: 'Analyst request failed' } });
    }
    await flushPromises();
    expect(w.find('.chat-status-banner').text()).toContain('Analyst request failed');
  });



  it('renders CardStore health unknown, ok, and degraded without treating absent as healthy', async () => {
    const unknown = await mountDashboard({ runtimeResponse: mockRuntimeStateResponse });
    expect(unknown.find('.cardstore-health').text()).toContain('Unknown / not available');
    expect(unknown.find('.cardstore-health').classes()).toContain('cardstore-unknown');

    const ok = await mountDashboard({ runtimeResponse: { ...mockRuntimeStateResponse, cardStoreHealth: mockCardStoreHealthOk } });
    expect(ok.find('.cardstore-health').text()).toContain('OK');
    expect(ok.find('.cardstore-health').classes()).toContain('cardstore-ok');

    const degraded = await mountDashboard({ runtimeResponse: { ...mockRuntimeStateResponse, cardStoreHealth: mockCardStoreHealthDegraded } });
    expect(degraded.find('.cardstore-health').text()).toContain('Degraded');
    expect(degraded.find('.cardstore-health').text()).toContain('Synthetic warning token=[REDACTED]');
    expect(degraded.find('.cardstore-health').text()).not.toContain('super-secret');
    expect(degraded.find('.cardstore-health').classes()).toContain('cardstore-degraded');
  });

  it('shows degraded runtime banner when runtime status is error', async () => {
    const w = await mountDashboard({ runtimeResponse: { runtime: { ...mockRuntimeState, status: 'error' }, cardIndex: mockCardIndex } });
    expect(w.find('.runtime-banner').text()).toContain('Runtime is degraded');
  });

  it('shows unauthorized runtime fetch failure as error banner', async () => {
    vi.mocked(getRuntimeState).mockRejectedValueOnce(new ApiError(401, 'Unauthorized', {}));
    const w = await mountDashboard();
    expect(w.find('.error-banner').text()).toContain('Unauthorized');
  });
});
