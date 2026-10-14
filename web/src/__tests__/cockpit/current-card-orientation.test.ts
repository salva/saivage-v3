import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import GlobalStrip from '../../components/layout/GlobalStrip.vue';
import { useCurrentCardOrientation } from '../../composables/useCurrentCardOrientation';
import { useRuntimeStore } from '../../stores/runtime';
import { useCardStore } from '../../stores/cards';
import { OperatorApiError } from '../../api/client';
import type { CardDetail } from '../../api/types';
import { cardDetail, noCurrentRuntimeStatus, runtimeStatusSnapshot, serverAvailability } from './fixtures';

const api = vi.hoisted(() => ({ getCard: vi.fn(), listCardRecords: vi.fn(), getRuntimeState: vi.fn(), getRuntimeStatus: vi.fn() }));
vi.mock('../../api/client', async (original) => ({ ...(await original<{ OperatorApiError: typeof OperatorApiError }>()), ...api }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (id: string, error: string | null = null): { card: CardDetail } => ({ card: cardDetail(id, {
  lifecycle: error === null
    ? { status: 'running', error: null, result: null, completed_at: null }
    : { status: 'failed', error, result: { kind: 'runtime-failure', summary: error }, completed_at: '2026-10-14T12:00:00.000Z' },
}) });
const missing = () => new OperatorApiError('cards.get', 404, { error: 'Card not found', cardId: 'card-b' });
const unauthorized = () => new OperatorApiError('cards.get', 401, { error: 'Unauthorized', statusCode: 401 });

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  api.getRuntimeState.mockResolvedValue({ projectId: 'project', runtime: { status: 'running', project_id: 'project', current_card_id: 'card-a', pid: 4242, started_at: '2026-10-14T12:00:00.000Z', updated_at: '2026-10-14T12:00:00.000Z' }, serverAvailability: serverAvailability() });
  api.listCardRecords.mockResolvedValue({ card_id: 'card-c', records: [] });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('admission-owned current-card observation', () => {
  it.each([
    ['success', 'pending'], ['failure', 'pending'], ['success', 'settled'], ['failure', 'settled'],
  ] as const)('ignores real departed %s callbacks when B is %s and across null/disposal', async (settlement, replacement) => {
    const id = ref<string | null>('card-a');
    const admitted = ref(true);
    const a = deferred<ReturnType<typeof response>>();
    const b = deferred<ReturnType<typeof response>>();
    const c = deferred<ReturnType<typeof response>>();
    const d = deferred<ReturnType<typeof response>>();
    api.getCard.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise).mockReturnValueOnce(d.promise);
    let state!: ReturnType<typeof useCurrentCardOrientation>;
    const wrapper = mount(defineComponent({ setup() { state = useCurrentCardOrientation(() => id.value, () => admitted.value); return () => null; } }));
    id.value = 'card-b';
    await flushPromises();
    expect(api.getCard.mock.calls[0]![1].aborted).toBe(true);
    if (replacement === 'settled') { b.resolve(response('card-b')); await flushPromises(); }
    if (settlement === 'success') a.resolve(response('card-a', 'departed')); else a.reject(missing());
    await flushPromises();
    expect(state.detail.value?.id ?? null).toBe(replacement === 'settled' ? 'card-b' : null);
    expect(state.outcome.value).toBe(replacement === 'settled' ? 'observed' : 'loading');
    if (replacement === 'pending') b.resolve(response('card-b'));
    await flushPromises();
    expect(state.outcome.value).toBe('observed');
    id.value = 'card-c';
    await flushPromises();
    id.value = null;
    await flushPromises();
    expect(api.getCard.mock.calls[2]![1].aborted).toBe(true);
    if (settlement === 'success') c.resolve(response('card-c')); else c.reject(unauthorized());
    await flushPromises();
    expect(state.outcome.value).toBe('idle');
    expect(state.detail.value?.id).toBe('card-b');
    id.value = 'card-d';
    await flushPromises();
    wrapper.unmount();
    expect(api.getCard.mock.calls[3]![1].aborted).toBe(true);
    if (settlement === 'success') d.resolve(response('card-d')); else d.reject(missing());
    await flushPromises();
    expect(state.detail.value?.id).toBe('card-b');
    expect(state.outcome.value).toBe('loading'); // disposal publishes no callbacks
  });

  it.each(['success', 'failure'] as const)('resets admission, rereads retained same identity, and ignores late B %s after returned A succeeds', async (settlement) => {
    const id = ref<string | null>('card-a');
    const admitted = ref(true);
    const b = deferred<ReturnType<typeof response>>();
    const returnedA = deferred<ReturnType<typeof response>>();
    api.getCard.mockResolvedValueOnce(response('card-a', 'old A')).mockReturnValueOnce(b.promise).mockReturnValueOnce(returnedA.promise);
    let state!: ReturnType<typeof useCurrentCardOrientation>;
    const wrapper = mount(defineComponent({ setup() { state = useCurrentCardOrientation(() => id.value, () => admitted.value); return () => null; } }));
    await flushPromises();
    id.value = 'card-b'; await flushPromises();
    id.value = 'card-a'; await flushPromises();
    expect(api.getCard.mock.calls.map(([identity]) => identity)).toEqual(['card-a', 'card-b', 'card-a']);
    expect(state.outcome.value).toBe('loading');
    returnedA.resolve(response('card-a', 'new A')); await flushPromises();
    if (settlement === 'success') b.resolve(response('card-b', 'departed B')); else b.reject(missing());
    await flushPromises();
    expect(state.outcome.value).toBe('observed');
    expect(state.detail.value?.lifecycle.error).toBe('new A');
    admitted.value = false; await flushPromises();
    expect(state.outcome.value).toBe('idle');
    api.getCard.mockRejectedValueOnce(new Error('private transport body'));
    admitted.value = true; await flushPromises();
    expect(state.outcome.value).toBe('failed');
    expect(api.getCard).toHaveBeenCalledTimes(4);
    wrapper.unmount();
  });
});

async function renderStrip(initialId: string | null = 'card-a', fetchInitially = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const runtime = useRuntimeStore(pinia);
  async function observe(id: string | null) {
    api.getRuntimeStatus.mockResolvedValue(id === null ? noCurrentRuntimeStatus() : runtimeStatusSnapshot({ currentCardId: id }));
    await runtime.fetchState();
    await flushPromises();
  }
  if (fetchInitially) await observe(initialId);
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', name: 'home', component: { template: '<div />' } },
    { path: '/cards/:id', name: 'card-detail', component: { template: '<div />' } },
    { path: '/files', name: 'files', component: { template: '<div />' } },
    { path: '/system', name: 'system', component: { template: '<div />' } },
  ] });
  await router.push('/');
  const wrapper = mount(GlobalStrip, { global: { plugins: [pinia, router] } });
  await flushPromises();
  const notices = () => wrapper.findAll('.strip-problem').map((node) => node.text());
  return { wrapper, runtime, observe, notices, pinia };
}

describe('rendered current versus retained orientation', () => {
  it('qualifies departed A while B loads, attributes successful B, and clears old problems on healthy success', async () => {
    const b = deferred<ReturnType<typeof response>>();
    api.getCard.mockResolvedValueOnce(response('card-a', 'A problem')).mockReturnValueOnce(b.promise).mockResolvedValueOnce(response('card-c'));
    const view = await renderStrip();
    expect(view.notices()).toEqual(['Current card card-a: A problem']);
    await view.observe('card-a');
    expect(api.getCard).toHaveBeenCalledTimes(1);
    await view.observe('card-b');
    expect(view.wrapper.get('[data-testid="strip-current-work"]').text()).toBe('card-b');
    expect(view.notices()).toEqual(['Current card card-b details loading.', 'Last-known card card-a: A problem']);
    b.resolve(response('card-b', 'B problem')); await flushPromises();
    expect(view.notices()).toEqual(['Current card card-b: B problem']);
    await view.observe('card-c');
    expect(view.notices()).toEqual([]);
    view.wrapper.unmount();
  });

  it.each([['failed', () => new Error('private error body'), 'could not be loaded.'], ['not-found', missing, 'unavailable (card not found).']] as const)(
    'distinguishes %s and rereads A after B and null without claiming retained same-ID freshness', async (_outcome, failure, copy) => {
      const a2 = deferred<ReturnType<typeof response>>();
      const a3 = deferred<ReturnType<typeof response>>();
      api.getCard.mockResolvedValueOnce(response('card-a', 'A problem')).mockRejectedValueOnce(failure()).mockReturnValueOnce(a2.promise).mockReturnValueOnce(a3.promise);
      const view = await renderStrip();
      await view.observe('card-b');
      expect(view.notices()).toEqual([`Current card card-b details ${copy}`, 'Last-known card card-a: A problem']);
      await view.observe('card-a');
      expect(view.notices()).toEqual(['Current card card-a details loading.', 'Last-known card card-a: A problem']);
      a2.reject(new Error('private error body')); await flushPromises();
      expect(view.notices()).toEqual(['Current card card-a details could not be loaded.', 'Last-known card card-a: A problem']);
      await view.observe(null);
      expect(view.wrapper.get('[data-testid="strip-current-work"]').text()).toBe('No current work');
      expect(view.notices()).toEqual(['Last-known card card-a: A problem']);
      await view.observe('card-a');
      expect(api.getCard.mock.calls.filter(([id]) => id === 'card-a')).toHaveLength(3);
      expect(view.notices()).toEqual(['Current card card-a details loading.', 'Last-known card card-a: A problem']);
      a3.resolve(response('card-a', 'updated A')); await flushPromises();
      expect(view.notices()).toEqual(['Current card card-a: updated A']);
      view.wrapper.unmount();
    },
  );

  it.each([['failed', () => new Error('secret'), 'could not be loaded.'], ['not-found', missing, 'unavailable (card not found).']] as const)(
    'shows initial loading and %s without any retained detail', async (_outcome, failure, copy) => {
      const a = deferred<ReturnType<typeof response>>(); api.getCard.mockReturnValueOnce(a.promise);
      const view = await renderStrip(null, false);
      expect(view.wrapper.get('[data-testid="strip-current-work"]').text()).toBe('Current work unknown');
      expect(api.getCard).not.toHaveBeenCalled();
      await view.observe('card-a');
      expect(view.notices()).toEqual(['Current card card-a details loading.']);
      a.reject(failure()); await flushPromises();
      expect(view.notices()).toEqual([`Current card card-a details ${copy}`]);
      view.wrapper.unmount();
    },
  );

  it('suppresses retained text for detail/runtime unauthorized and cancels pending work on revoked admission', async () => {
    const c = deferred<ReturnType<typeof response>>();
    api.getCard.mockResolvedValueOnce(response('card-a', 'private retained problem')).mockRejectedValueOnce(unauthorized()).mockReturnValueOnce(c.promise);
    const view = await renderStrip();
    await view.observe('card-b');
    expect(view.notices()).toEqual(['Current card details unavailable (unauthorized).']);
    expect(view.wrapper.text()).not.toContain('private retained problem');
    await view.observe('card-c');
    api.getRuntimeState.mockRejectedValueOnce(new OperatorApiError('runtime.getState', 401, { error: 'Unauthorized', statusCode: 401 }));
    await expect(view.runtime.fetchState()).rejects.toBeInstanceOf(OperatorApiError); await flushPromises();
    expect(api.getCard.mock.calls[2]![1].aborted).toBe(true);
    expect(view.wrapper.get('[data-testid="strip-current-work"]').text()).toBe('Current work unavailable');
    expect(view.wrapper.find('[data-testid="strip-current-work"] a').exists()).toBe(false);
    expect(view.notices()).toEqual(['Current card details unavailable (unauthorized).']);
    c.resolve(response('card-c', 'late private problem')); await flushPromises();
    expect(view.wrapper.text()).not.toContain('private problem');
    view.wrapper.unmount();
  });

  it('shows fixed initial detail unauthorized and admits no card read for initial runtime unauthorized', async () => {
    api.getCard.mockRejectedValueOnce(unauthorized());
    const view = await renderStrip();
    expect(view.notices()).toEqual(['Current card details unavailable (unauthorized).']);
    view.wrapper.unmount();
    api.getCard.mockClear();
    const initial = await renderStrip(null, false);
    api.getRuntimeState.mockRejectedValueOnce(new OperatorApiError('runtime.getState', 401, { error: 'Unauthorized', statusCode: 401 }));
    await expect(initial.runtime.fetchState()).rejects.toBeInstanceOf(OperatorApiError); await flushPromises();
    expect(initial.wrapper.get('[data-testid="strip-current-work"]').text()).toBe('Current work unavailable');
    expect(initial.notices()).toEqual(['Current card details unavailable (unauthorized).']);
    expect(api.getCard).not.toHaveBeenCalled();
    initial.wrapper.unmount();
  });

  it('keeps selected C independent from runtime A', async () => {
    api.getCard.mockImplementation(async (id: string) => response(id, `${id} problem`));
    const view = await renderStrip();
    await useCardStore(view.pinia).fetchCardDetail('card-c'); await flushPromises();
    expect(useCardStore(view.pinia).selectedCardId).toBe('card-c');
    expect(view.wrapper.get('[data-testid="strip-current-work"]').text()).toBe('card-a');
    expect(view.notices()).toEqual(['Current card card-a: card-a problem']);
    view.wrapper.unmount();
  });
});
