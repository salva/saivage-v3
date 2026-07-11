import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AppShell from '../components/layout/AppShell.vue';

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => 'token') }));

vi.mock('../api/client', () => ({
  listChatSessions: vi.fn(async () => ({ sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', started_at: '2026-01-01T00:00:00Z' }] })),
  getChatEntries: vi.fn(async (sessionId: string) => ({ sessionId, entries: [] })),
  sendChatMessage: vi.fn(async (sessionId: string) => ({ sessionId, toolInvocations: [], restart: null })),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

vi.mock('../stores/sync', () => ({
  useSyncStore: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    registerResource: vi.fn(() => vi.fn()),
    connectionState: 'connected',
  }),
}));
vi.mock('../stores/cards', () => ({ useCardStore: () => ({ refetch: vi.fn(async () => undefined) }) }));
vi.mock('../stores/agents', () => ({ useAgentStore: () => ({ refetch: vi.fn(async () => undefined) }) }));

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: { template: '<div>dashboard</div>' } },
      { path: '/cards', name: 'cards', component: { template: '<div>cards</div>' } },
      { path: '/cards/:id', name: 'card-detail', component: { template: '<div>card</div>' } },
      { path: '/timeline', name: 'timeline', component: { template: '<div>timeline</div>' } },
      { path: '/agents', name: 'agents', component: { template: '<div>agents</div>' } },
      { path: '/agents/:id', name: 'agent-detail', component: { template: '<div>agent detail</div>' } },
      { path: '/files', name: 'files', component: { template: '<div>files</div>' } },
      { path: '/debug', name: 'debug', component: { template: '<div>debug</div>' } },
    ],
  });
}

describe('AppShell project name', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('renders the project name in the Analyst pane header outside WorkspaceHeader', async () => {
    const router = createTestRouter();
    await router.push('/dashboard');
    await router.isReady();

    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await flushPromises();

    expect(wrapper.find('.app-top-bar').exists()).toBe(false);
    expect(wrapper.get('.analyst-pane-project-name').text()).toContain('saivage-v3');
    expect(wrapper.get('.workspace-header').text()).not.toContain('saivage-v3');

    wrapper.unmount();
  });
});
