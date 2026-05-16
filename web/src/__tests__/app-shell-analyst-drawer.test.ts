import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { ref, computed } from 'vue';
import AppShell from '../components/layout/AppShell.vue';

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => 'token') }));
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
    await button.trigger('click');
    await flushPromises();
    expect(localStorage.getItem('analyst-chat:drawer-state')).toContain('"open":true');
    expect(button.attributes('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(wrapper.get('textarea').element);
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
