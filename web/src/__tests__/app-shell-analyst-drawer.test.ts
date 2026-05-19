import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { ref, computed } from 'vue';
import AppShell from '../components/layout/AppShell.vue';

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => 'token') }));

vi.mock('../api/client', () => ({
  listAgentSessions: vi.fn(async () => ({ sessions: [] })),
  getChatMessages: vi.fn(async (sessionId: string) => ({ sessionId, messages: [] })),
  sendChatMessage: vi.fn(async (sessionId: string) => ({ sessionId, message: { id: 'm1', content: 'ok', timestamp: '2025-01-01T00:00:00Z' } })),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.status = status; this.body = body; } get isUnauthorized() { return this.status === 401; } },
}));

vi.mock('../stores/ws', () => ({
  useWsStore: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    onType: vi.fn(() => () => {}),
    connectionState: ref('connected'),
  }),
}));
vi.mock('../stores/runtime', () => ({
  useRuntimeStore: () => ({
    setupWsListener: vi.fn(),
    fetchState: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    statusLabel: computed(() => 'running'),
    isPaused: computed(() => false),
    status: computed(() => 'running'),
    liveUpdateLabel: computed(() => 'Live'),
    liveUpdateDetail: computed(() => 'Live'),
    runtimeModeLabel: computed(() => 'Running'),
    runtimeDetail: computed(() => 'Running'),
    isStale: computed(() => false),
    unauthorized: computed(() => false),
    pauseActionDisabledReason: computed(() => null),
  }),
}));

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/dashboard', name: 'dashboard', component: { template: '<div>dashboard</div>' } },
    { path: '/cards', name: 'cards', component: { template: '<div>cards</div>' } },
    { path: '/cards/:id', name: 'card-detail', component: { template: '<div>card</div>' } },
    { path: '/agents', name: 'agents', component: { template: '<div>agents</div>' } },
    { path: '/files', name: 'files', component: { template: '<div>files</div>' } },
    { path: '/debug', name: 'debug', component: { template: '<div>debug</div>' } },
  ],
});

describe('AppShell analyst drawer', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    localStorage.clear();
    await router.push('/dashboard');
    await router.isReady();
  });

  it('opens from header button, persists to localStorage, and exposes expanded state', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    const button = wrapper.get('.analyst-chip');
    expect(button.attributes('aria-expanded')).toBe('false');
    const panelId = button.attributes('aria-controls');
    expect(panelId).toBe('analyst-chat-panel');
    await button.trigger('click');
    await flushPromises();
    const panel = wrapper.get(`#${panelId}`);
    expect(panel.attributes('role')).toBe('dialog');
    expect(localStorage.getItem('analyst-chat:drawer-state')).toContain('"open":true');
    expect(button.attributes('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(wrapper.get('textarea').element);
    wrapper.unmount();
  });


  it('closes the analyst drawer on route changes so it does not overlay /files or /cards/:id', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await wrapper.get('.analyst-chip').trigger('click');
    await flushPromises();
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);

    await router.push('/files');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/files');
    expect(wrapper.text()).toContain('Files');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(false);

    await wrapper.get('.analyst-chip').trigger('click');
    await flushPromises();
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    await router.push('/cards/card-1');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/cards/card-1');
    expect(wrapper.text()).toContain('Card Detail');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(false);
    wrapper.unmount();
  });

  it('toggles with Ctrl/Cmd+J keyboard shortcut', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
    await flushPromises();
    expect(localStorage.getItem('analyst-chat:drawer-state')).toContain('"open":true');
    expect(document.activeElement).toBe(wrapper.get('textarea').element);
    wrapper.unmount();
  });
});
