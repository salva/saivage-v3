import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import GlobalStrip from '../../components/layout/GlobalStrip.vue';
import { useRuntimeStore } from '../../stores/runtime';
import { cardDetail, noCurrentRuntimeStatus, runtimeStatusSnapshot, serverAvailability } from './fixtures';

const api = vi.hoisted(() => ({
  getRuntimeState: vi.fn(),
  getRuntimeStatus: vi.fn(),
  getCard: vi.fn(),
  restartServer: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  ...api,
}));

async function renderStrip() {
  const pinia = createPinia();
  setActivePinia(pinia);
  await useRuntimeStore(pinia).fetchState();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/cards/:id', name: 'card-detail', component: { template: '<div />' } },
      { path: '/files', name: 'files', component: { template: '<div />' } },
      { path: '/system', name: 'system', component: { template: '<div />' } },
    ],
  });
  await router.push('/');
  await router.isReady();
  const wrapper = mount(GlobalStrip, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

function expectNoProjectCommandButtons() {
  const controls = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="global-strip"] button')];
  for (const command of ['Start project', 'Stop project', 'Pause', 'Resume']) {
    expect(controls.map((button) => button.textContent?.trim())).not.toContain(command);
  }
  expect(document.querySelector('[data-testid="strip-stop"]')).toBeNull();
}

describe('global strip runtime controls', () => {
  beforeEach(() => {
    api.getRuntimeState.mockResolvedValue({ projectId: 'fixture-project', runtime: null, serverAvailability: serverAvailability() });
    api.getCard.mockResolvedValue({ card: cardDetail('card-a-b') });
    api.restartServer.mockResolvedValue({ status: 'restart_scheduled' });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it.each([
    ['running', runtimeStatusSnapshot({ restart_server_available: false })],
    ['stopped', noCurrentRuntimeStatus({ restart_server_available: false })],
  ])('shows observations but no direct runtime commands when %s without restart capability', async (_name, status) => {
    api.getRuntimeStatus.mockResolvedValue(status);
    const wrapper = await renderStrip();

    expect(wrapper.get('[data-testid="strip-lifecycle"]').text().toLowerCase()).toContain(status.runtime);
    expect(wrapper.get('[data-testid="strip-updates"] summary').text()).toBe('Updates');
    expectNoProjectCommandButtons();
    expect(wrapper.find('[data-testid="strip-restart"]').exists()).toBe(false);
    expect(wrapper.findAll('.strip-controls button')).toHaveLength(0);
    wrapper.unmount();
  });

  it.each([
    ['running', runtimeStatusSnapshot({ restart_server_available: true })],
    ['stopped', noCurrentRuntimeStatus({ restart_server_available: true })],
  ])('offers only confirmed server restart when %s with capability', async (_name, status) => {
    api.getRuntimeStatus.mockResolvedValue(status);
    const wrapper = await renderStrip();

    expectNoProjectCommandButtons();
    expect(wrapper.findAll('.strip-controls button')).toHaveLength(1);
    await wrapper.get('[data-testid="strip-restart"]').trigger('click');
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Restart server');

    if (status.runtime === 'running') {
      const input = document.querySelector<HTMLInputElement>('[data-testid="restart-confirmation-input"]')!;
      const submit = document.querySelector<HTMLButtonElement>('[data-testid="restart-confirmation-submit"]')!;
      expect(submit.disabled).toBe(true);
      input.value = 'RESTART SERVER';
      input.dispatchEvent(new Event('input'));
      await flushPromises();
      expect(submit.disabled).toBe(false);
      submit.click();
      await flushPromises();
      expect(api.restartServer).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
    wrapper.unmount();
  });
});
