import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AppShell from '../components/layout/AppShell.vue';

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => 'token') }));

vi.mock('../api/client', () => ({
  listChatSessions: vi.fn(async () => ({ sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', started_at: '2026-01-01T00:00:00Z' }] })),
  getChatEntries: vi.fn(async (sessionId: string) => ({ sessionId, entries: [] })),
  sendChatMessage: vi.fn(async (sessionId: string) => ({ sessionId, message: { id: 'm1', role: 'assistant', kind: 'text', content: 'ok', timestamp: '2025-01-01T00:00:00Z' }, toolInvocations: [] })),
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

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/dashboard', name: 'dashboard', component: { template: '<div>dashboard</div>' } },
    { path: '/cards', name: 'cards', component: { template: '<div>cards</div>' } },
    { path: '/cards/:id', name: 'card-detail', component: { template: '<div>card</div>' } },
    { path: '/timeline', name: 'timeline', component: { template: '<div>timeline</div>' } },
    { path: '/agents', name: 'agents', component: { template: '<div>agents</div>' } },
    { path: '/files', name: 'files', component: { template: '<div>files</div>' } },
    { path: '/debug', name: 'debug', component: { template: '<div>debug</div>' } },
  ],
});

describe('AppShell persistent analyst panel', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    localStorage.clear();
    await router.push('/dashboard');
    await router.isReady();
  });

  it('renders workspace and analyst regions on first paint without drawer controls or localStorage state', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await flushPromises();

    expect(wrapper.find('.nav-rail').exists()).toBe(true);
    expect(wrapper.find('.workspace-content').exists()).toBe(true);
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    expect(wrapper.find('.analyst' + '-chip').exists()).toBe(false);
    expect(wrapper.find('[aria-controls="analyst-chat-panel"]').exists()).toBe(false);
    expect(localStorage.getItem('analyst-chat:drawer-state')).toBeNull();

    const composer = wrapper.get<HTMLTextAreaElement>('textarea[aria-label="Analyst chat composer"]');
    expect(composer.element.disabled).toBe(false);
    wrapper.unmount();
  });

  it('leaves Ctrl/Cmd+J as a no-op for analyst visibility and drawer storage', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await flushPromises();
    const panel = wrapper.get('#analyst-chat-panel');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
    await flushPromises();

    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    expect(wrapper.get('#analyst-chat-panel').element).toBe(panel.element);
    expect(localStorage.getItem('analyst-chat:drawer-state')).toBeNull();
    wrapper.unmount();
  });

  it('keeps the analyst region visible across route changes', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await flushPromises();
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);

    await router.push('/files');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/files');
    expect(wrapper.text()).toContain('Files');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);

    await router.push('/cards/card-1');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/cards/card-1');
    expect(wrapper.text()).toContain('Card Detail');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    wrapper.unmount();
  });
});
