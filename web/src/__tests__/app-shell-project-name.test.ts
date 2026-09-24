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
    registerResource: vi.fn(() => vi.fn()),
    openConversation: vi.fn(() => vi.fn()),
    connectionState: ref('connected'),
  }),
}));
vi.mock('../stores/cards', () => ({ useCardStore: () => ({ ensureRoot: vi.fn(async () => undefined), loadedChildrenFor: vi.fn(() => undefined) }) }));

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div>home</div>' } },
      { path: '/cards', name: 'cards', component: { template: '<div>cards</div>' } },
      { path: '/cards/:id', name: 'card-detail', component: { template: '<div>card</div>' } },
      { path: '/agents/:id', name: 'agent-detail', component: { template: '<div>agent detail</div>' } },
      { path: '/files', name: 'files', component: { template: '<div>files</div>' } },
      { path: '/system', name: 'system', component: { template: '<div>system</div>' } },
    ],
  });
}

describe('AppShell project name', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('renders the project name in the Analyst pane header, not in the global strip identity', async () => {
    const router = createTestRouter();
    await router.push('/');
    await router.isReady();

    const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [createPinia(), router] } });
    await flushPromises();

    expect(wrapper.get('.analyst-pane-project-name').text()).toBe('saivage');
    expect(wrapper.get('.strip-project').text()).toBe('saivage');

    wrapper.unmount();
  });
});
