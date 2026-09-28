import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type RouteLocationNormalizedLoaded, type RouteLocationRaw, type Router } from 'vue-router';
import { useWorkspaceRouteStore } from '../../stores/workspaceRoute';
import type { WorkspaceNavigationTarget } from '../../api/contracts';

function route(name: string, params: Record<string, unknown> = {}, query: Record<string, unknown> = {}): RouteLocationNormalizedLoaded {
  return {
    path: `/${name}`,
    fullPath: `/${name}`,
    name,
    params,
    query,
    hash: '',
    matched: [],
    meta: {},
    redirectedFrom: undefined,
  } as unknown as RouteLocationNormalizedLoaded;
}

function makeRouter(initial = route('home')): Router & { pushMock: ReturnType<typeof vi.fn>; replaceMock: ReturnType<typeof vi.fn>; triggerAfterEach: (to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) => void } {
  let afterEachHook: ((to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) => void) | null = null;
  const pushMock = vi.fn();
  const replaceMock = vi.fn();
  return {
    currentRoute: { value: initial },
    afterEach: vi.fn((hook) => { afterEachHook = hook as typeof afterEachHook; return vi.fn(); }),
    push: pushMock,
    replace: replaceMock,
    pushMock,
    replaceMock,
    triggerAfterEach(to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) {
      afterEachHook?.(to, from);
    },
  } as unknown as Router & { pushMock: ReturnType<typeof vi.fn>; replaceMock: ReturnType<typeof vi.fn>; triggerAfterEach: (to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) => void };
}

describe('workspaceRoute store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('reflects the initial route on store registration', () => {
    const router = makeRouter(route('card-detail', { id: '11111111-1111-4111-8111-111111111111' }, { tab: 'history' }));
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    expect(store.current).toEqual({ view: 'cockpit', entityId: '11111111-1111-4111-8111-111111111111', refinement: { tab: 'history' }, routeName: 'card-detail' });
  });

  it('updates current and stores the previous route after router.afterEach', () => {
    const router = makeRouter(route('home'));
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    router.triggerAfterEach(route('agent-detail', { id: 'agent:planner:project' }), route('home'));
    expect(store.current).toEqual({ view: 'cockpit', entityId: 'agent:planner:project', refinement: null, routeName: 'agent-detail' });
    store.apply({ intent: 'navigate_back' });
    expect(router.replaceMock).toHaveBeenCalledWith({ name: 'home', query: undefined });
  });

  it('maps every navigate_workspace target kind to its exact router.push argument', () => {
    const router = makeRouter();
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    const rows: Array<{ target: WorkspaceNavigationTarget; expected: RouteLocationRaw }> = [
      { target: { kind: 'card', id: '11111111-1111-4111-8111-111111111111' }, expected: { name: 'card-detail', params: { id: '11111111-1111-4111-8111-111111111111' }, query: undefined } },
      { target: { kind: 'transcript', id: 'agent:planner:project' }, expected: { name: 'agent-detail', params: { id: 'agent:planner:project' }, query: undefined } },
      { target: { kind: 'process', id: 'pid-1' }, expected: { name: 'system', query: { section: 'processes', process: 'pid-1' } } },
      { target: { kind: 'process_list' }, expected: { name: 'system', query: { section: 'processes' } } },
      { target: { kind: 'agent_session_list' }, expected: { name: 'system', query: { section: 'participants' } } },
    ];
    for (const row of rows) {
      store.apply({ intent: 'navigate_workspace', target: row.target });
      expect(router.pushMock).toHaveBeenLastCalledWith(row.expected);
    }
    expect(router.pushMock).toHaveBeenCalledTimes(rows.length);
  });

  it.each(['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'])('rejects invalid transcript target %s before navigation', (id) => {
    const router = makeRouter();
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    store.apply({ intent: 'navigate_workspace', target: { kind: 'transcript', id } });
    expect(router.pushMock).not.toHaveBeenCalled();
  });

  it('navigate_back restores without re-recording the route being left', () => {
    const router = makeRouter(route('cards'));
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    router.triggerAfterEach(route('card-detail', { id: '11111111-1111-4111-8111-111111111111' }), route('cards'));

    store.apply({ intent: 'navigate_back' });
    expect(router.replaceMock).toHaveBeenCalledWith({ name: 'cards', query: undefined });

    router.triggerAfterEach(route('cards'), route('card-detail', { id: '11111111-1111-4111-8111-111111111111' }));
    store.apply({ intent: 'navigate_back' });
    expect(router.replaceMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the back-stack to 16 entries', () => {
    const router = makeRouter(route('home'));
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    for (let index = 0; index < 17; index += 1) {
      const cardId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
      router.triggerAfterEach(route('card-detail', { id: cardId(index + 1) }), route('card-detail', { id: cardId(index) }));
    }
    store.apply({ intent: 'navigate_back' });
    expect(router.replaceMock).toHaveBeenCalledWith({ name: 'card-detail', params: { id: '00000000-0000-4000-8000-000000000016' }, query: undefined });
  });

  it('navigate_back on an empty stack does not push and does not throw', () => {
    const router = makeRouter();
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    expect(() => store.apply({ intent: 'navigate_back' })).not.toThrow();
    expect(router.pushMock).not.toHaveBeenCalled();
  });

  function realRouter() {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: { template: '<div />' } },
        { path: '/cards/:id', name: 'card-detail', component: { template: '<div />' } },
        { path: '/agents/:id', name: 'agent-detail', component: { template: '<div />' } },
        { path: '/files', name: 'files', component: { template: '<div />' } },
        { path: '/system', name: 'system', component: { template: '<div />' } },
      ],
    });
  }

  async function logicalBack(store: ReturnType<typeof useWorkspaceRouteStore>): Promise<string> {
    store.apply({ intent: 'navigate_back' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return store.current.routeName ?? '';
  }

  it('single-flights automatic replacement and omits only its synthetic source from logical history', async () => {
    const router = realRouter();
    await router.push('/files');
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    await router.push('/cards/card-a');
    await router.push('/cards/card-a?facet=conversations');
    const source = router.currentRoute.value;

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    router.beforeEach(async (to) => {
      if (to.name === 'agent-detail' && to.params.id === 'agent:executor:card-a') await held;
    });
    const replace = vi.spyOn(router, 'replace');
    const first = store.replaceWithAutomaticSession(source, 'agent:executor:card-a');
    const duplicate = store.replaceWithAutomaticSession(source, 'agent:executor:card-a');
    expect(replace).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, duplicate]);
    expect(router.currentRoute.value.fullPath).toBe('/agents/agent:executor:card-a');

    await router.push('/agents/agent:reviewer:card-a');
    expect(store.current.entityId).toBe('agent:reviewer:card-a');
    expect(await logicalBack(store)).toBe('agent-detail');
    expect(router.currentRoute.value.params.id).toBe('agent:executor:card-a');
    expect(await logicalBack(store)).toBe('card-detail');
    expect(router.currentRoute.value.fullPath).toBe('/cards/card-a');
    expect(await logicalBack(store)).toBe('files');
    expect(router.currentRoute.value.fullPath).toBe('/files');
    expect(await logicalBack(store)).toBe('files');
  });

  it('keeps a failed automatic source and permits a fresh replacement after cleanup', async () => {
    const router = realRouter();
    await router.push('/files');
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    await router.push('/cards/card-a');
    await router.push('/cards/card-a?facet=conversations');
    let abort = true;
    router.beforeEach((to) => to.name === 'agent-detail' && to.params.id === 'agent:executor:card-a' && abort ? false : true);
    const source = router.currentRoute.value;
    const replace = vi.spyOn(router, 'replace');
    await Promise.all([
      store.replaceWithAutomaticSession(source, 'agent:executor:card-a'),
      store.replaceWithAutomaticSession(source, 'agent:executor:card-a'),
    ]);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.fullPath).toBe('/cards/card-a?facet=conversations');

    await router.push('/agents/agent:reviewer:card-a');
    expect(await logicalBack(store)).toBe('card-detail');
    expect(router.currentRoute.value.fullPath).toBe('/cards/card-a?facet=conversations');
    expect(await logicalBack(store)).toBe('card-detail');
    expect(router.currentRoute.value.fullPath).toBe('/cards/card-a');
    expect(await logicalBack(store)).toBe('files');

    await router.push('/cards/card-a?facet=conversations');
    abort = false;
    const beforeFresh = replace.mock.calls.length;
    await store.replaceWithAutomaticSession(router.currentRoute.value, 'agent:executor:card-a');
    expect(router.currentRoute.value.params.id).toBe('agent:executor:card-a');
    expect(replace).toHaveBeenCalledTimes(beforeFresh + 1);
  });

  it('does not leak automatic suppression when unrelated navigation cancels the pending replacement', async () => {
    const router = realRouter();
    await router.push('/files');
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    await router.push('/cards/card-a?facet=conversations');
    const source = router.currentRoute.value;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    router.beforeEach(async (to) => {
      if (to.name === 'agent-detail') await held;
    });
    const automatic = store.replaceWithAutomaticSession(source, 'agent:executor:card-a');
    const unrelated = router.push('/system');
    release();
    await Promise.all([automatic, unrelated]);
    await router.push('/files');

    store.apply({ intent: 'navigate_back' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.currentRoute.value.fullPath).toBe('/system');
  });

  it('keeps stale requests inert and clears a rejected replacement for a fresh legitimate call', async () => {
    const router = realRouter();
    await router.push('/cards/card-a');
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    const stale = router.currentRoute.value;
    await router.push('/cards/card-a?facet=conversations');
    const replace = vi.spyOn(router, 'replace');

    await store.replaceWithAutomaticSession(stale, 'agent:executor:card-a');
    expect(replace).not.toHaveBeenCalled();

    replace.mockRejectedValueOnce(new Error('synthetic replace rejection'));
    await expect(store.replaceWithAutomaticSession(
      router.currentRoute.value,
      'agent:executor:card-a',
    )).rejects.toThrow('synthetic replace rejection');
    expect(router.currentRoute.value.fullPath).toBe('/cards/card-a?facet=conversations');

    await store.replaceWithAutomaticSession(router.currentRoute.value, 'agent:executor:card-a');
    expect(router.currentRoute.value.params.id).toBe('agent:executor:card-a');
  });
});
