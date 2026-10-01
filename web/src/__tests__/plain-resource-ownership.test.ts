import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, reactive, ref } from 'vue';
import type { listFiles } from '../api/client';

const api = vi.hoisted(() => ({ getConfig: vi.fn(), listProviders: vi.fn(), listControlActions: vi.fn(), getFileContent: vi.fn(), getAgentSession: vi.fn(), getCard: vi.fn() }));
const route = reactive({ name: 'agent-detail', params: { id: 'agent:analyst:global' }, query: {} });
vi.mock('vue-router', () => ({ useRoute: () => route }));
vi.mock('../api/client', async (original) => ({ ...(await original<{ OperatorApiError: typeof OperatorApiError; listFiles: typeof listFiles }>()), ...api }));
import { useSystemResourcesStore } from '../stores/systemResources';
import { useFileStore } from '../stores/files';
import { useExactSessionRoute } from '../composables/useExactSessionRoute';
import { useCurrentCardOrientation } from '../composables/useCurrentCardOrientation';
import { OperatorApiError } from '../api/client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('semantic plain resource owners', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); route.name = 'agent-detail'; route.params.id = 'agent:analyst:global'; });

  it('keeps last-good config on failure, independently observes providers/actions, and cancels at disposal', async () => {
    const config = { marker: 'last-good' };
    api.getConfig.mockResolvedValueOnce(config).mockRejectedValueOnce(new Error('refresh failed'));
    api.listProviders.mockResolvedValue({ providers: [] });
    api.listControlActions.mockResolvedValue({ actions: [] });
    const store = useSystemResourcesStore();
    await store.fetchConfig();
    await Promise.all([store.fetchConfig(), store.fetchProviders(), store.fetchActions()]);
    expect(store.config).toEqual(config);
    expect(store.configError).toBe('refresh failed');
    expect(store.providers).toEqual({ providers: [] });
    expect(store.actions).toEqual({ actions: [] });
    const late = deferred<unknown>();
    api.getConfig.mockReturnValue(late.promise);
    const pending = store.fetchConfig();
    const signal = api.getConfig.mock.calls.at(-1)![0] as AbortSignal;
    store.$dispose();
    expect(signal.aborted).toBe(true);
    late.resolve({ marker: 'disposed' });
    await pending;
    expect(store.config).toEqual(config);
    expect(store.configLoading).toBe(false);
  });

  it('file clear suppresses pending content, and different Pinia instances never supersede each other', async () => {
    const a = useFileStore();
    setActivePinia(createPinia());
    const b = useFileStore();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    api.getFileContent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p = a.fetchFileContent('a');
    const q = b.fetchFileContent('b');
    first.resolve({ content: 'A' });
    await p;
    expect(a.viewedFile).toEqual({ content: 'A' });
    b.clearViewedFile();
    expect(b.contentLoading).toBe(false);
    second.resolve({ content: 'B' });
    await q;
    expect(b.viewedFile).toBeNull();
    expect(b.viewerState).toBe('idle');
    a.$dispose(); b.$dispose();
  });

  it('exact route clears the previous summary and rejects departed responses on route exit/disposal', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    api.getAgentSession.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let state!: ReturnType<typeof useExactSessionRoute>;
    const wrapper = mount(defineComponent({ setup() { state = useExactSessionRoute(); return () => null; } }));
    route.params.id = 'agent:oversight:global';
    await flushPromises();
    first.resolve({ session: { id: 'agent:analyst:global' } });
    await flushPromises();
    expect(state.summary.value).toBeNull();
    expect(state.loading.value).toBe(true);
    route.name = 'system';
    await flushPromises();
    expect((api.getAgentSession.mock.calls[1]![1] as AbortSignal).aborted).toBe(true);
    wrapper.unmount();
    second.resolve({ session: { id: 'agent:oversight:global' } });
    await flushPromises();
    expect(state.summary.value).toBeNull();
    expect(state.loading.value).toBe(false);
  });

  it('orientation keeps last-good detail on failure and suppresses a departed identity on disposal', async () => {
    const id = ref<string | null>('card-a');
    api.getCard.mockResolvedValueOnce({ card: { id: 'card-a' } }).mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new OperatorApiError('cards.get', 404, { error: 'Card not found', cardId: 'card-missing' }));
    let state!: ReturnType<typeof useCurrentCardOrientation>;
    const wrapper = mount(defineComponent({ setup() { state = useCurrentCardOrientation(() => id.value, () => true); return () => null; } }));
    await flushPromises();
    id.value = 'card-b';
    await flushPromises();
    expect(state.detail.value).toEqual({ id: 'card-a' });
    id.value = 'card-missing';
    await flushPromises();
    expect(state.unavailable.value).toBe(true);
    expect(state.detail.value).toEqual({ id: 'card-a' });
    const late = deferred<unknown>();
    api.getCard.mockReturnValueOnce(late.promise);
    id.value = 'card-c';
    await flushPromises();
    wrapper.unmount();
    expect((api.getCard.mock.calls[3]![1] as AbortSignal).aborted).toBe(true);
    late.resolve({ card: { id: 'card-c' } });
    await flushPromises();
    expect(state.detail.value).toEqual({ id: 'card-a' });
  });
});
