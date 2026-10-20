import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { onMounted, onUnmounted, ref } from 'vue';
import AppShell from '../components/layout/AppShell.vue';
import { useAnalystChat } from '../stores/analystChat';

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => 'token') }));

const api = vi.hoisted(() => ({ getChatEntries: vi.fn(), getAgentConversation: vi.fn() }));
const live = vi.hoisted(() => ({ events: [] as string[], openConversation: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getChatEntries: api.getChatEntries,
  getAgentConversation: api.getAgentConversation,
  sendChatMessage: vi.fn(async () => ({ toolInvocations: [], restart: null })),
}));

vi.mock('../stores/sync', () => ({
  useSyncStore: () => ({
    connect: vi.fn(),
    registerResource: vi.fn(() => vi.fn()),
    openConversation: live.openConversation,
    connectionState: ref('connected'),
  }),
}));
vi.mock('../stores/cards', () => ({
  useCardStore: () => ({ loadedChildrenFor: vi.fn(() => undefined) }),
}));

const AgentDetail = {
  template: '<div>agent detail</div>',
  setup() {
    onMounted(() => live.events.push('agent-mounted'));
    onUnmounted(() => live.events.push('agent-unmounted'));
  },
};

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'home', component: { template: '<div>home</div>', setup() { onMounted(() => live.events.push('home-mounted')); } } },
    { path: '/cards', name: 'cards', component: { template: '<div>cards</div>' } },
    { path: '/cards/:id', name: 'card-detail', component: { template: '<div>card</div>' } },
    { path: '/agents/:id', name: 'agent-detail', component: AgentDetail },
    { path: '/files', name: 'files', component: { template: '<div>files</div>' } },
    { path: '/system', name: 'system', component: { template: '<div>system</div>' } },
  ],
});

describe('AppShell persistent analyst panel', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
    live.events.length = 0;
    api.getChatEntries.mockResolvedValue({ session_id: 'agent:analyst:global', mode: 'internal', internal_enabled: true, external_enabled: false });
    api.getAgentConversation.mockResolvedValue({
      session_id: 'agent:analyst:global',
      segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1,
      segment_context: null,
      entries: [],
      cursor: { segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 1, message_id: null },
    });
    live.openConversation.mockImplementation(() => {
      live.events.push('analyst-open');
      return () => live.events.push('analyst-close');
    });
    await router.push('/');
    await router.isReady();
  });

  it('renders workspace and analyst regions on first paint without drawer controls or localStorage state', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await flushPromises();

    expect(wrapper.find('.global-strip').exists()).toBe(true);
    expect(wrapper.find('.workspace-content').exists()).toBe(true);
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    expect(wrapper.find('.analyst' + '-chip').exists()).toBe(false);
    expect(wrapper.find('[aria-controls="analyst-chat-panel"]').exists()).toBe(false);
    expect(localStorage.getItem('analyst-chat:drawer-state')).toBeNull();
    expect(api.getChatEntries).toHaveBeenCalledOnce();
    expect(api.getAgentConversation).not.toHaveBeenCalled();
    expect(live.events.filter(event => event === 'home-mounted')).toHaveLength(1);

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
    expect(push).toHaveBeenCalledWith({ name: 'files' });
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
    expect(wrapper.text()).toContain('card');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    wrapper.unmount();
  });

  it('suppresses the persistent panel on canonical analyst detail to avoid duplicate transcript display', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await flushPromises();

    await router.push('/agents/agent%3Aplanner%3Aproject');
    await flushPromises();
    expect(wrapper.text()).toContain('agent detail');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);

    live.events.length = 0;
    await router.push('/agents/agent%3Aanalyst%3Aglobal');
    await flushPromises();
    expect(wrapper.text()).toContain('agent detail');
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(false);
    expect(live.events.indexOf('analyst-close')).toBeLessThan(live.events.indexOf('agent-mounted'));

    live.events.length = 0;
    await router.push('/');
    await flushPromises();
    expect(live.events.indexOf('agent-unmounted')).toBeLessThan(
      live.events.indexOf('analyst-open'),
    );
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);

    wrapper.unmount();
  });

  it('withholds both composer and valid Agent inspector while availability is pending', async () => {
    const identity = deferred<{ session_id: 'agent:analyst:global'; mode: 'internal'; internal_enabled: boolean; external_enabled: boolean }>();
    api.getChatEntries.mockReturnValueOnce(identity.promise);
    await router.push('/agents/agent%3Aanalyst%3Aglobal');
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: { plugins: [createPinia(), router] },
    });
    await flushPromises();

    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analyst-identity-pending"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('agent detail');

    identity.resolve({ session_id: 'agent:analyst:global', mode: 'internal', internal_enabled: true, external_enabled: false });
    await flushPromises();
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(false);
    expect(wrapper.text()).toContain('agent detail');
    wrapper.unmount();
  });

  it('shows identity failure without enabling a composer or valid Agent inspector', async () => {
    api.getChatEntries.mockRejectedValueOnce(new Error('identity unavailable'));
    await router.push('/agents/agent%3Aanalyst%3Aglobal');
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: { plugins: [createPinia(), router] },
    });
    await flushPromises();

    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analyst-identity-failed"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Analyst identity is unavailable');
    expect(wrapper.text()).not.toContain('agent detail');
    wrapper.unmount();
  });

  it('makes a stale matching teardown continuation inert after a rapid route change', async () => {
    const identity = deferred<{ session_id: 'agent:analyst:global'; mode: 'internal'; internal_enabled: boolean; external_enabled: boolean }>();
    api.getChatEntries.mockReturnValueOnce(identity.promise);
    await router.push('/agents/agent%3Aanalyst%3Aglobal');
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: { plugins: [createPinia(), router] },
    });
    await flushPromises();

    identity.resolve({ session_id: 'agent:analyst:global', mode: 'internal', internal_enabled: true, external_enabled: false });
    await Promise.resolve();
    await router.push('/agents/agent%3Aplanner%3Aproject');
    await flushPromises();

    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    expect(wrapper.text()).toContain('agent detail');
    expect(wrapper.find('[data-testid="analyst-identity-pending"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not treat invalid Agent route text as the singleton Analyst identity', async () => {
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await router.push('/agents/agent%3Aanalyst%3Aother');
    await flushPromises();
    expect(wrapper.find('#analyst-chat-panel').exists()).toBe(true);
    wrapper.unmount();
  });

  it('reclaims the disabled workspace and removes all interaction affordances while retaining drafts and exact inspection', async () => {
    api.getChatEntries.mockResolvedValue({ session_id: 'agent:analyst:global', mode: 'external', internal_enabled: false, external_enabled: true });
    const pinia = createPinia();
    const chat = useAnalystChat(pinia);
    chat.setDraft('Retained unsent draft');
    const focus = vi.fn(); window.addEventListener('saivage:focus-chat', focus);
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.classes()).toContain('analyst-pane-suppressed');
    expect(wrapper.find('#analyst-pane').exists()).toBe(false);
    expect(wrapper.find('a[href="#analyst-pane"]').exists()).toBe(false);
    expect(wrapper.find('.mobile-pane-switch').exists()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
    expect(focus).not.toHaveBeenCalled();
    await router.push('/agents/agent%3Aanalyst%3Aglobal'); await flushPromises();
    expect(wrapper.text()).toContain('Retained history is read-only');
    expect(wrapper.text()).toContain('agent detail');
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(chat.draft).toBe('Retained unsent draft');
    window.removeEventListener('saivage:focus-chat', focus);
    wrapper.unmount();
  });

  it('keeps both-mode drafts, focus shortcut and mobile activity on the ordinary internal surface', async () => {
    api.getChatEntries.mockResolvedValue({ session_id: 'agent:analyst:global', mode: 'both', internal_enabled: true, external_enabled: true });
    const pinia = createPinia(); const chat = useAnalystChat(pinia);
    chat.setDraft('Both-mode draft');
    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.find('a[href="#analyst-pane"]').exists()).toBe(true);
    expect(wrapper.get('textarea').element.value).toBe('Both-mode draft');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' })); await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('textarea').element);
    expect(wrapper.classes()).toContain('pane-analyst');
    chat.sending = true; await flushPromises();
    expect(wrapper.find('.activity-dot').exists()).toBe(true);
    await router.push('/files'); await flushPromises();
    expect(chat.draft).toBe('Both-mode draft');
    expect(wrapper.get('.chat-send-button').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});
