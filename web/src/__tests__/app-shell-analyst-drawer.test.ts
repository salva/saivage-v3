import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
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
    localStorage.clear();
    await router.push('/dashboard');
    await router.isReady();
  });

  it('opens from header button and persists to localStorage', async () => {
    const wrapper = mount(AppShell, { global: { plugins: [createPinia(), router] } });
    await wrapper.find('.analyst-chip').trigger('click');
    expect(localStorage.getItem('analyst-chat:drawer-state')).toContain('"open":true');
  });

  it('toggles with Ctrl/Cmd+J keyboard shortcut', async () => {
    const wrapper = mount(AppShell, { global: { plugins: [createPinia(), router] } });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
    await wrapper.vm.$nextTick();
    expect(localStorage.getItem('analyst-chat:drawer-state')).toContain('"open":true');
  });
});
