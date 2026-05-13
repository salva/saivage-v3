/**
 * Bounded component-level regression tests for the DashboardView
 * chat flow and runtime-status behaviour.
 *
 * Tests cover:
 *  1. Chat panel renders with empty state and input area
 *  2. Chat initialization populates messages from API on mount
 *  3. Chat send/render path — typing a message and clicking send
 *  4. Runtime status panel renders with sections (Current Work, Workers, Queue, etc.)
 *  5. Runtime refresh button triggers fetchState and updates display
 *  6. Error display when runtime fetch fails
 *  7. Incident-state variants: frozen, error, connecting, unauthorized WS states
 *
 * The API client and WebSocket store are fully mocked — no server needed.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from '../views/DashboardView.vue';
import type { ChatMessage, RuntimeState, CardIndex, ChatResponse } from '../api/types';

// ── Reactive state for ws mock ────────────────────────────────
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

// ── Mock the WebSocket store ──────────────────────────────────

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
    sendMessage: (text: string) => { mockSendMessageCalls.push(text); },
    isConnected: () => mockWsIsConnected,
    isConnecting: () => false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

// ── Mock the API client ───────────────────────────────────────

vi.mock('../api/client', () => {
  const ApiError = class extends Error {
    status: number; body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message); this.name = 'ApiError'; this.status = status; this.body = body;
    }
  };
  return { listChatSessions: vi.fn(), getChatMessages: vi.fn(), sendChatMessage: vi.fn(),
    getRuntimeState: vi.fn(), pauseRuntime: vi.fn(), resumeRuntime: vi.fn(), ApiError };
});

import { listChatSessions, getChatMessages, sendChatMessage, getRuntimeState, ApiError } from '../api/client';

// ── Mock vue-router ───────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  return { ...actual, useRouter: () => ({ push: mockPush, currentRoute: { value: { query: {} } } }) };
});

// ── Fixtures ──────────────────────────────────────────────────

const mockChatSessions = { sessions: [
  { id: 'chat-sess-1', role: 'analyst', status: 'active', started_at: '2025-06-01T10:00:00Z' },
]};

const mockChatHistory: ChatMessage[] = [
  { id: 'msg-1', session_id: 'chat-sess-1', role: 'user', kind: 'text',
    content: 'Hello analyst!', timestamp: '2025-06-01T10:01:00Z' },
  { id: 'msg-2', session_id: 'chat-sess-1', role: 'assistant', kind: 'text',
    content: 'Hello! How can I help you today?', timestamp: '2025-06-01T10:01:05Z' },
];

const mockChatResponse: ChatResponse = {
  sessionId: 'chat-sess-1',
  message: { id: 'msg-3', session_id: 'chat-sess-1', role: 'assistant', kind: 'text',
    content: 'I have created **card-abc** for your request.', timestamp: '2025-06-01T10:02:00Z' },
};

const mockRuntimeState: RuntimeState = {
  status: 'running', project_id: 'saivage-v3', pid: 12345,
  started_at: '2025-06-01T08:00:00Z', current_card_id: 'card-001',
  current_agent_session_id: 'agent-sess-xyz', paused: false, paused_at: null,
  queue: ['card-002', 'card-003', 'card-004'],
  running_processes: ['proc-1', 'proc-2'], updated_at: '2025-06-01T10:30:00Z',
};

const mockCardIndex: CardIndex = {
  total: 42, byStatus: { done: 30, failed: 3, blocked: 2, active: 5, backlog: 2 },
  byType: { code: 20, test: 10, plan: 5, goal: 3, doc: 4 },
};

const mockRuntimeStateResponse = { runtime: mockRuntimeState, cardIndex: mockCardIndex };

// ── Router ────────────────────────────────────────────────────

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: { template: '<div>Dashboard</div>' } },
      { path: '/cards/:id', name: 'card-detail', component: { template: '<div>Card</div>' } },
      { path: '/agents/:id', name: 'agent-detail', component: { template: '<div>Agent</div>' } },
      { path: '/files', name: 'files', component: { template: '<div>Files</div>' } },
    ],
  });
}

// ── Mount helper ──────────────────────────────────────────────

async function mountDashboard(opts?: {
  runtimeResponse?: any; chatSessionsResponse?: any; chatMessagesResponse?: any;
  /** If true, skip resetting ws state (caller already configured it) */
  keepWsState?: boolean;
}) {
  if (!opts?.keepWsState) resetTestState();
  setActivePinia(createPinia());

  vi.mocked(listChatSessions).mockResolvedValue(opts?.chatSessionsResponse ?? mockChatSessions);
  vi.mocked(getChatMessages).mockResolvedValue({
    sessionId: 'chat-sess-1', messages: opts?.chatMessagesResponse ?? mockChatHistory,
  });
  vi.mocked(sendChatMessage).mockResolvedValue(mockChatResponse);
  vi.mocked(getRuntimeState).mockResolvedValue(opts?.runtimeResponse ?? mockRuntimeStateResponse);

  const router = makeRouter();
  const wrapper = mount(DashboardView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return wrapper;
}

// ── Test helpers ──────────────────────────────────────────────

async function typeChat(w: ReturnType<typeof mount>, text: string) { await w.find('.chat-input').setValue(text); }
async function clickSend(w: ReturnType<typeof mount>) { await w.find('.send-btn').trigger('click'); }

// ── Tests ─────────────────────────────────────────────────────

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    resetTestState();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('chat panel — initialization & render', () => {
    it('renders the chat panel with correct aria-label', async () => {
      const w = await mountDashboard();
      expect(w.find('section[aria-label="Analyst Chat"]').exists()).toBe(true);
    });

    it('shows the panel title "Analyst Chat"', async () => {
      const w = await mountDashboard();
      expect(w.find('.chat-panel .panel-title').text()).toBe('Analyst Chat');
    });

    it('shows the LIVE session badge when WebSocket is connected', async () => {
      const w = await mountDashboard();
      expect(w.find('.session-badge.live').exists()).toBe(true);
      expect(w.find('.session-badge.live').text()).toBe('LIVE');
    });

    it('shows the OFFLINE session badge when WebSocket is disconnected', async () => {
      _wsConnectionState.value = 'offline';
      mockWsIsConnected = false;
      const w = await mountDashboard({ keepWsState: true, chatSessionsResponse: { sessions: [] } });
      expect(w.find('.session-badge.offline').exists()).toBe(true);
      expect(w.find('.session-badge.offline').text()).toBe('OFFLINE');
    });

    it('renders the chat input with "Message the analyst" when connected', async () => {
      const w = await mountDashboard();
      expect(w.find('.chat-input').attributes('placeholder')).toContain('Message the analyst');
    });

    it('renders the send button', async () => {
      expect((await mountDashboard()).find('.send-btn').exists()).toBe(true);
    });

    it('loads chat history on mount via initChat', async () => {
      const w = await mountDashboard();
      expect(listChatSessions).toHaveBeenCalledOnce();
      expect(getChatMessages).toHaveBeenCalledWith('chat-sess-1');
      const msgs = w.findAll('.chat-message');
      expect(msgs.length).toBeGreaterThanOrEqual(2);
      expect(msgs[0].find('.message-content').text()).toContain('Hello analyst');
    });

    it('renders empty state when no chat sessions exist', async () => {
      // Need ws connected so chat is enabled, but sessions list is empty
      _wsConnectionState.value = 'connected';
      mockWsIsConnected = true;
      // override handled via mountDashboard opts
      const w = await mountDashboard({ keepWsState: true, chatSessionsResponse: { sessions: [] } });
      expect(w.find('.chat-empty').exists()).toBe(true);
      expect(w.find('.chat-empty').text()).toContain('Send a message');
    });

    it('displays message roles correctly (You/Analyst)', async () => {
      const w = await mountDashboard();
      const roles = w.findAll('.chat-message').map((m) => m.find('.message-role').text());
      expect(roles).toContain('You');
      expect(roles).toContain('Analyst');
    });

    it('renders markdown content for assistant messages', async () => {
      const md: ChatMessage[] = [{ id: 'md', session_id: 'cs1', role: 'assistant', kind: 'text',
        content: 'I created **card-abc**. Here is some `code`.', timestamp: '2025-06-01T10:05:00Z' }];
      const w = await mountDashboard({ chatMessagesResponse: md });
      const c = w.find('.message-content.markdown');
      expect(c.exists()).toBe(true);
      expect(c.html()).toContain('<strong>card-abc</strong>');
      expect(c.html()).toContain('<code class="inline-code">code</code>');
    });
  });

  describe('chat panel — send/render path', () => {
    it('sends a message and renders the assistant response', async () => {
      const w = await mountDashboard();
      await typeChat(w, 'Create a new card for testing');
      await clickSend(w);
      await flushPromises();

      expect(sendChatMessage).toHaveBeenCalledWith('chat-sess-1', 'Create a new card for testing');
      expect(mockSendMessageCalls).toContain('Create a new card for testing');

      const userMsgs = w.findAll('.chat-message.role-user');
      expect(userMsgs[userMsgs.length - 1].find('.message-content').text())
        .toContain('Create a new card for testing');
      const asstMsgs = w.findAll('.chat-message.role-assistant');
      expect(asstMsgs[asstMsgs.length - 1].find('.message-content').text())
        .toContain('created');
    });

    it('clears the input after sending', async () => {
      const w = await mountDashboard();
      await typeChat(w, 'Hello');
      await clickSend(w);
      await flushPromises();
      expect((w.find('.chat-input').element as HTMLTextAreaElement).value).toBe('');
    });

    it('does not send an empty message', async () => {
      const w = await mountDashboard();
      vi.mocked(sendChatMessage).mockClear();
      await clickSend(w);
      await flushPromises();
      expect(sendChatMessage).not.toHaveBeenCalled();
    });

    it('disables the chat input when WebSocket is offline', async () => {
      _wsConnectionState.value = 'offline';
      mockWsIsConnected = false;
      const w = await mountDashboard({ keepWsState: true, chatSessionsResponse: { sessions: [] } });
      expect(w.find('.chat-input').attributes('disabled')).toBeDefined();
    });

    it('shows error message in chat when send fails', async () => {
      const w = await mountDashboard();
      vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error('Network error'));
      await typeChat(w, 'This will fail');
      await clickSend(w);
      await flushPromises();
      const errs = w.findAll('.chat-message.role-system.kind-activity')
        .map((m) => m.find('.message-content').text());
      expect(errs.some((t) => t.includes('Error'))).toBe(true);
    });

    it('handles chat response with tool invocations', async () => {
      const toolResp: ChatResponse = {
        sessionId: 'chat-sess-1',
        message: { id: 'mt', session_id: 'cs1', role: 'assistant', kind: 'text',
          content: 'Let me run that.', timestamp: '2025-06-01T10:03:00Z' },
        toolInvocations: [{ tool: 'run_command',
          params: { command: 'npm test', cwd: '/work/saivage-v3' },
          result: { status: 'ok' } }],
      };
      vi.mocked(sendChatMessage).mockResolvedValueOnce(toolResp);
      const w = await mountDashboard();
      await typeChat(w, 'Run the tests');
      await clickSend(w);
      await flushPromises();
      const badges = w.findAll('.tool-badge');
      expect(badges.length).toBeGreaterThanOrEqual(1);
      expect(badges.map((t) => t.text()).some((t) => t.includes('run_command'))).toBe(true);
    });

    it('Enter key (no shift) sends the message', async () => {
      const w = await mountDashboard();
      await w.find('.chat-input').setValue('Keyboard send');
      await w.find('.chat-input').trigger('keydown', { key: 'Enter', shiftKey: false });
      await flushPromises();
      expect(sendChatMessage).toHaveBeenCalledWith('chat-sess-1', 'Keyboard send');
    });

    it('Shift+Enter does not send', async () => {
      const w = await mountDashboard();
      vi.mocked(sendChatMessage).mockClear();
      await w.find('.chat-input').setValue('Not sent');
      await w.find('.chat-input').trigger('keydown', { key: 'Enter', shiftKey: true });
      await flushPromises();
      expect(sendChatMessage).not.toHaveBeenCalled();
    });
  });

  describe('runtime status panel — presentation', () => {
    it('renders the runtime status panel', async () => {
      expect((await mountDashboard()).find('section[aria-label="Runtime Status"]').exists()).toBe(true);
    });

    it('shows "Runtime Status" title', async () => {
      expect((await mountDashboard()).find('.status-panel .panel-title').text()).toBe('Runtime Status');
    });

    it('displays Current Work with status chip "running"', async () => {
      const w = await mountDashboard();
      expect(w.findAll('.section-label').map((s) => s.text().trim())).toContain('Current Work');
      const chip = w.find('.status-chip');
      expect(chip.text().trim()).toBe('running');
      expect(chip.classes()).toContain('rt-running');
    });

    it('displays active card ID', async () => {
      expect((await mountDashboard()).find('.status-value.clickable').text()).toBe('card-001');
    });

    it('shows "none" when no active card', async () => {
      const w = await mountDashboard({
        runtimeResponse: { runtime: { ...mockRuntimeState, current_card_id: null }, cardIndex: mockCardIndex },
      });
      expect(w.findAll('.status-value.dim').map((d) => d.text())).toContain('none');
    });

    it('displays Workers section with running process count', async () => {
      const w = await mountDashboard();
      const lbl = w.findAll('.section-label').find((s) => s.text().includes('Workers'));
      expect(lbl).toBeTruthy();
      expect(lbl!.text()).toContain('2');
    });

    it('displays agent session ID in Workers', async () => {
      const el = (await mountDashboard()).findAll('.status-value.clickable')
        .find((e) => e.text().includes('agent-sess'));
      expect(el).toBeTruthy();
    });

    it('displays Queue section with card IDs', async () => {
      const w = await mountDashboard();
      expect(w.findAll('.queue-item')).toHaveLength(3);
      expect(w.find('.queue-item').text()).toBe('card-002');
    });

    it('shows "Queue empty" when queue is empty', async () => {
      const w = await mountDashboard({
        runtimeResponse: { runtime: { ...mockRuntimeState, queue: [] }, cardIndex: mockCardIndex },
      });
      expect(w.text()).toContain('Queue empty');
    });

    it('displays Recent History stats', async () => {
      const w = await mountDashboard();
      expect(w.find('.status-value.success').text()).toBe('30');
      expect(w.find('.status-value.danger').text()).toBe('5');
      expect(w.text()).toContain('42');
    });

    it('displays Card Index bar rows', async () => {
      expect((await mountDashboard()).findAll('.index-bar-row')).toHaveLength(5);
    });

    it('navigates to card detail on active card click', async () => {
      const w = await mountDashboard();
      await w.find('.status-value.clickable').trigger('click');
      expect(mockPush).toHaveBeenCalledWith({ name: 'card-detail', params: { id: 'card-001' } });
    });

    it('navigates to card detail on queue item click', async () => {
      const w = await mountDashboard();
      await w.find('.queue-item').trigger('click');
      expect(mockPush).toHaveBeenCalledWith({ name: 'card-detail', params: { id: 'card-002' } });
    });
  });

  describe('runtime status panel — refresh & error', () => {
    it('calls refreshRuntime on mount', async () => {
      await mountDashboard();
      expect(getRuntimeState).toHaveBeenCalled();
    });

    it('renders refresh button', async () => {
      expect((await mountDashboard()).find('.refresh-btn').exists()).toBe(true);
    });

    it('clicking refresh calls fetchState again', async () => {
      const w = await mountDashboard();
      vi.mocked(getRuntimeState).mockClear();
      await w.find('.refresh-btn').trigger('click');
      await flushPromises();
      expect(getRuntimeState).toHaveBeenCalledTimes(1);
    });

    it('shows error banner on fetch failure', async () => {
      vi.mocked(getRuntimeState).mockRejectedValueOnce(new ApiError(503, 'Service unavailable', {}));
      const w = await mountDashboard({});
      await flushPromises();
      expect(w.find('.error-banner').text()).toContain('Service unavailable');
    });

    it('error banner clears on successful refresh', async () => {
      vi.mocked(getRuntimeState)
        .mockRejectedValueOnce(new ApiError(500, 'Boom', {}))
        .mockResolvedValueOnce(mockRuntimeStateResponse);
      const w = await mountDashboard({});
      await flushPromises();
      expect(w.find('.error-banner').exists()).toBe(true);
      await w.find('.refresh-btn').trigger('click');
      await flushPromises();
      expect(w.find('.error-banner').exists()).toBe(false);
    });

    it('shows Loading when runtime is pending', async () => {
      // Defer the runtime response so loading state is visible
      let resolveRt: (v: any) => void;
      const pendingRt = new Promise<any>((r) => { resolveRt = r; });

      vi.mocked(getRuntimeState).mockReturnValue(pendingRt);
      // Keep chat sessions empty so initChat resolves quickly
      // override handled via mountDashboard opts

      // Don't reset -- keep ws connected
      _wsConnectionState.value = 'connected';
      mockWsIsConnected = true;

      setActivePinia(createPinia());
      const router = makeRouter();
      const w = mount(DashboardView, { global: { plugins: [createPinia(), router] } });

      // initChat resolved (no sessions, empty state), refreshRuntime is pending
      // Flush microtasks for initChat
      await flushPromises();

      // Now loading should be visible: runtimeLoading=true, runtime=null
      expect(w.find('.status-loading').exists()).toBe(true);
      expect(w.find('.status-loading').text()).toBe('Loading...');

      // Resolve runtime
      resolveRt!(mockRuntimeStateResponse);
      await flushPromises();

      expect(w.find('.status-loading').exists()).toBe(false);
      expect(w.find('.status-chip').exists()).toBe(true);
    });

    it('shows rt-idle status chip for idle state', async () => {
      const w = await mountDashboard({
        runtimeResponse: {
          runtime: { ...mockRuntimeState, status: 'idle', running_processes: [], queue: [], current_card_id: null },
          cardIndex: { total: 0, byStatus: {}, byType: {} },
        },
      });
      expect(w.find('.status-chip').classes()).toContain('rt-idle');
    });

    it('shows rt-paused status chip for paused state', async () => {
      const w = await mountDashboard({
        runtimeResponse: {
          runtime: { ...mockRuntimeState, paused: true, paused_at: '2025-06-01T10:00:00Z' },
          cardIndex: mockCardIndex,
        },
      });
      expect(w.find('.status-chip').classes()).toContain('rt-paused');
    });
  });

  describe('incident-state variants — operator-visible states', () => {
    it('shows rt-frozen status chip with frozen_reason when runtime is frozen', async () => {
      const frozenRuntime: RuntimeState = {
        ...mockRuntimeState,
        status: 'frozen',
        paused: false,
        frozen_reason: 'security_halt: suspicious process detected',
        running_processes: [],
        queue: [],
        current_card_id: null,
        current_agent_session_id: null,
      };
      const w = await mountDashboard({
        runtimeResponse: { runtime: frozenRuntime, cardIndex: mockCardIndex },
      });
      const chip = w.find('.status-chip');
      expect(chip.exists()).toBe(true);
      expect(chip.text().trim()).toBe('frozen');
      expect(chip.classes()).toContain('rt-frozen');
    });

    it('shows rt-error status chip when runtime status is error', async () => {
      const errorRuntime: RuntimeState = {
        ...mockRuntimeState,
        status: 'error',
        paused: false,
        running_processes: [],
        current_card_id: null,
      };
      const w = await mountDashboard({
        runtimeResponse: { runtime: errorRuntime, cardIndex: mockCardIndex },
      });
      const chip = w.find('.status-chip');
      expect(chip.exists()).toBe(true);
      expect(chip.text().trim()).toBe('error');
      expect(chip.classes()).toContain('rt-error');
    });

    it('frozen status label takes precedence over paused flag', async () => {
      const frozenPausedRuntime: RuntimeState = {
        ...mockRuntimeState,
        status: 'frozen',
        paused: true,
        paused_at: '2025-06-01T12:00:00Z',
        frozen_reason: 'freeze-on-pause escalation',
      };
      const w = await mountDashboard({
        runtimeResponse: { runtime: frozenPausedRuntime, cardIndex: mockCardIndex },
      });
      const chip = w.find('.status-chip');
      expect(chip.text().trim()).toBe('frozen');
      expect(chip.classes()).toContain('rt-frozen');
      expect(chip.classes()).not.toContain('rt-paused');
    });

    it('shows OFFLINE badge and disabled chat when WebSocket is in connecting state', async () => {
      _wsConnectionState.value = 'connecting';
      mockWsIsConnected = false;
      const w = await mountDashboard({ keepWsState: true, chatSessionsResponse: { sessions: [] } });
      // In connecting state, the dashboard treats non-'connected' as OFFLINE
      expect(w.find('.session-badge.offline').exists()).toBe(true);
      expect(w.find('.session-badge.offline').text()).toBe('OFFLINE');
      // Chat input should be disabled
      expect(w.find('.chat-input').attributes('disabled')).toBeDefined();
      // Placeholder should indicate need to connect
      expect(w.find('.chat-input').attributes('placeholder')).toContain('Connect to chat');
    });

    it('shows OFFLINE badge and disabled chat when WebSocket is unauthorized', async () => {
      _wsConnectionState.value = 'unauthorized';
      mockWsIsConnected = false;
      const w = await mountDashboard({ keepWsState: true, chatSessionsResponse: { sessions: [] } });
      expect(w.find('.session-badge.offline').exists()).toBe(true);
      expect(w.find('.chat-input').attributes('disabled')).toBeDefined();
    });

    it('error banner displays when runtime fetch fails and status panel is hidden behind error', async () => {
      vi.mocked(getRuntimeState).mockRejectedValueOnce(new ApiError(500, 'Internal Server Error', {}));
      const w = await mountDashboard({});
      await flushPromises();
      // error banner visible
      const banner = w.find('.error-banner');
      expect(banner.exists()).toBe(true);
      expect(banner.text()).toContain('Internal Server Error');
      // status chip NOT rendered (template shows error banner instead of status sections)
      expect(w.find('.status-chip').exists()).toBe(false);
    });

    it('rt-unknown status chip renders when runtime is null and not loading', async () => {
      // Provide runtime=null so statusLabel returns 'unknown'
      const w = await mountDashboard({
        runtimeResponse: { runtime: null, cardIndex: { total: 0, byStatus: {}, byType: {} } },
      });
      const chip = w.find('.status-chip');
      expect(chip.exists()).toBe(true);
      expect(chip.classes()).toContain('rt-unknown');
      expect(chip.text().trim()).toBe('unknown');
    });
  });
});
