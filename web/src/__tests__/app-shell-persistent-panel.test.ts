import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { ref } from 'vue';
import AppShell from '../components/layout/AppShell.vue';

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => 'token') }));

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getChatEntries: vi.fn(async () => ({ session_id: 'agent:analyst:global' })),
  sendChatMessage: vi.fn(async () => ({ toolInvocations: [], restart: null })),
}));

vi.mock('../stores/sync', () => ({
  useSyncStore: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    registerResource: vi.fn(() => vi.fn()),
    openConversation: vi.fn(() => vi.fn()),
    connectionState: ref('connected'),
  }),
}));
vi.mock('../stores/cards', () => ({ useCardStore: () => ({ ensureRoot: vi.fn(async () => undefined) }) }));

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/dashboard', name: 'dashboard', component: { template: '<div>dashboard</div>' } },
    { path: '/cards', name: 'cards', component: { template: '<div>cards</div>' } },
    { path: '/cards/:id', name: 'card-detail', component: { template: '<div>card</div>' } },
    { path: '/agents', name: 'agents', component: { template: '<div>agents</div>' } },
    { path: '/agents/:id', name: 'agent-detail', component: { template: '<div>agent detail</div>' } },
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

  it('handles one bubbling descendant numeric shortcut with one navigation', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await flushPromises();
    const push = vi.spyOn(router, 'push');

    wrapper.get('.workspace-content').element.dispatchEvent(
      new KeyboardEvent('keydown', { key: '2', bubbles: true }),
    );
    await flushPromises();

    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith({ name: 'cards' });
    wrapper.unmount();
    push.mockRestore();
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

    await router.push('/cards/11111111-1111-4111-8111-111111111111');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/cards/11111111-1111-4111-8111-111111111111');
    expect(wrapper.text()).toContain('Card Detail');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    wrapper.unmount();
  });

  it('suppresses the persistent panel on canonical analyst detail to avoid duplicate transcript display', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await flushPromises();

    await router.push('/agents/agent%3Aplanner%3Aproject');
    await flushPromises();
    expect(wrapper.text()).toContain('Agent Detail');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);

    await router.push('/agents/agent%3Aanalyst%3Aglobal');
    await flushPromises();
    expect(wrapper.text()).toContain('Agent Detail');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(false);

    wrapper.unmount();
  });

  it('does not treat invalid Agent route text as the singleton Analyst identity', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await router.push('/agents/agent%3Aanalyst%3Aother');
    await flushPromises();
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    wrapper.unmount();
  });
});
