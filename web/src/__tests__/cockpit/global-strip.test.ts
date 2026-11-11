import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import GlobalStrip from '../../components/layout/GlobalStrip.vue';
import { useRuntimeStore } from '../../stores/runtime';
import { OperatorApiError } from '../../api/client';
import { cardDetail, noCurrentRuntimeStatus, oversightSnapshot, runtimeStatusSnapshot, serverAvailability } from './fixtures';

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

async function renderStrip(load = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  if (load) await useRuntimeStore(pinia).fetchState();
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
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('shows observation status, not intervention advice, before a runtime observation', async () => {
    const wrapper = await renderStrip(false);
    expect(wrapper.get('[data-testid="strip-lifecycle"]').text()).toBe('Unknown');
    expect(wrapper.get('[data-testid="strip-rest"]').text()).toBe('REST Not loaded');
    expect(wrapper.get('[data-testid="strip-current-work"]').text()).toBe('Current work unknown');
    expect(wrapper.find('[data-testid="strip-runtime-guidance"]').exists()).toBe(false);
    expectNoProjectCommandButtons();
    wrapper.unmount();
  });

  it('keeps qualified lifecycle help separate from faults through pause and refresh failures', async () => {
    api.getRuntimeStatus.mockResolvedValue(noCurrentRuntimeStatus({ runtime: 'running' }));
    const wrapper = await renderStrip();
    const guidance = () => wrapper.get('[data-testid="strip-runtime-guidance"]');
    expect(guidance().element.tagName).toBe('DETAILS');
    expect(guidance().get('summary').attributes('aria-describedby')).toBe('strip-lifecycle');
    expect(guidance().text()).toContain('wait for observed Paused');
    expect(guidance().attributes('role')).toBeUndefined();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="strip-lifecycle"]').attributes('aria-description')).toContain('edits are unavailable');

    api.getRuntimeStatus.mockResolvedValue(noCurrentRuntimeStatus({ runtime: 'pausing' }));
    await useRuntimeStore().fetchState(); await flushPromises();
    expect(guidance().text()).toContain('no time bound');
    expect(guidance().text()).toContain('edits remain unavailable');

    api.getRuntimeState.mockResolvedValue({ projectId: 'fixture-project', runtime: null, serverAvailability: {
      ...serverAvailability(), components: { ...serverAvailability().components, runtime: {
        state: 'degraded', source: 'runtime-application', checkedAt: '2026-08-14T00:00:00.000Z',
        diagnostic: { code: 'runtime-status-read-failed', summary: 'Synthetic runtime availability fault.' },
      } },
    } });
    api.getRuntimeStatus.mockResolvedValue(noCurrentRuntimeStatus({ runtime: 'paused' }));
    await useRuntimeStore().fetchState(); await flushPromises();
    expect(guidance().text()).toContain('Resume to continue the same Run');
    expect(wrapper.get('[role="alert"]').text()).toBe('Synthetic runtime availability fault.');
    expect(wrapper.get('[role="alert"]').text()).not.toContain('Resume');

    api.getRuntimeStatus.mockRejectedValueOnce(new Error('offline'));
    await expect(useRuntimeStore().fetchState()).rejects.toThrow('offline'); await flushPromises();
    expect(guidance().text()).toContain('Last observed lifecycle: Paused.');
    expect(guidance().text()).toContain('other holds may still refuse them');
    expect(wrapper.get('[data-testid="strip-rest"]').attributes('title')).toContain('Last successful observation is retained');

    api.getRuntimeStatus.mockRejectedValueOnce(new OperatorApiError('runtime.status', 401, { error: 'Unauthorized', statusCode: 401 }));
    await expect(useRuntimeStore().fetchState()).rejects.toThrow(); await flushPromises();
    expect(wrapper.find('[data-testid="strip-runtime-guidance"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Current card details unavailable (unauthorized).');
    expectNoProjectCommandButtons();
    wrapper.unmount();
  });

  it('keeps runtime error and availability faults in the alert channel', async () => {
    api.getRuntimeStatus.mockResolvedValue(noCurrentRuntimeStatus({ runtime: 'error' }));
    const wrapper = await renderStrip();
    expect(wrapper.get('[role="alert"]').text()).toContain('Inspect System for recovery evidence');
    expect(wrapper.get('[data-testid="strip-runtime-guidance"]').text()).toContain('not an automatic remedy');
    wrapper.unmount();
  });

  it.each([
    [541_000.5, 'About 9m 2s'],
    [0, 'Timer wait elapsed; check not yet observed'],
  ])('presents sampled wait %s without a wall deadline, retaining it on failed refresh', async (sample, label) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T13:51:00Z'));
    api.getRuntimeStatus.mockResolvedValue(runtimeStatusSnapshot({ oversight: oversightSnapshot({ remaining_wait_ms: sample }) }));
    const wrapper = await renderStrip();
    const chip = wrapper.get('[data-testid="strip-oversight"]');
    expect(chip.text()).toBe('Oversight waiting');
    expect(chip.attributes('title')).toContain(`Remaining timer wait at last observation: ${label}`);
    expect(chip.attributes('title')).toContain('No wall-clock check deadline');
    vi.setSystemTime(new Date('2026-09-24T17:00:00Z'));
    api.getRuntimeStatus.mockRejectedValueOnce(new Error('offline'));
    await expect(useRuntimeStore().fetchState()).rejects.toThrow('offline'); await flushPromises();
    expect(chip.attributes('title')).toContain(label);
    expect(wrapper.get('[data-testid="strip-rest"]').text()).toContain('Refresh failed');
    api.getRuntimeStatus.mockResolvedValue(runtimeStatusSnapshot({ oversight: oversightSnapshot({ remaining_wait_ms: 60_001 }) }));
    await useRuntimeStore().fetchState(); await flushPromises();
    expect(chip.attributes('title')).toContain('About 1m 1s');
    for (const state of ['checking', 'unavailable'] as const) {
      api.getRuntimeStatus.mockResolvedValue(runtimeStatusSnapshot({ oversight: oversightSnapshot({ state, eligible: false, eligibility_reason: state === 'checking' ? 'check_in_flight' : 'application_closing', remaining_wait_ms: null }) }));
      await useRuntimeStore().fetchState(); await flushPromises();
      expect(chip.text()).toBe(`Oversight ${state}`);
      expect(chip.attributes('title')).toContain('No armed wait');
    }
    wrapper.unmount();
  });

  it.each([
    ['running', runtimeStatusSnapshot({ restart_server_available: false })],
    ['stopped', noCurrentRuntimeStatus({ restart_server_available: false })],
  ])('shows observations but no direct runtime commands when %s without restart capability', async (_name, status) => {
    api.getRuntimeStatus.mockResolvedValue(status);
    const wrapper = await renderStrip();

    expect(wrapper.get('img[alt="Saivage"]').attributes()).toMatchObject({
      src: '/saivage-original.svg', width: '32', height: '32',
    });
    expect(wrapper.get('[data-testid="strip-project"]').text()).toBe('fixture-project');
    expect(wrapper.get('nav[aria-label="Primary navigation"]').text()).toContain('Cockpit');
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
