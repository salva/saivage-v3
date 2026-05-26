import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { RouteLocationNormalizedLoaded, RouteLocationRaw, Router } from 'vue-router';
import { useWorkspaceRouteStore, type NavigateTarget } from '../../stores/workspaceRoute';

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

function makeRouter(initial = route('dashboard')): Router & { pushMock: ReturnType<typeof vi.fn>; triggerAfterEach: (to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) => void } {
  let afterEachHook: ((to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) => void) | null = null;
  const pushMock = vi.fn();
  return {
    currentRoute: { value: initial },
    afterEach: vi.fn((hook) => { afterEachHook = hook as typeof afterEachHook; return vi.fn(); }),
    push: pushMock,
    pushMock,
    triggerAfterEach(to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) {
      afterEachHook?.(to, from);
    },
  } as unknown as Router & { pushMock: ReturnType<typeof vi.fn>; triggerAfterEach: (to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) => void };
}

describe('workspaceRoute store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('reflects the initial route on store registration', () => {
    const router = makeRouter(route('card-detail', { id: 'card-1' }, { tab: 'history' }));
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    expect(store.current).toEqual({ view: 'cards', entityId: 'card-1', refinement: { tab: 'history' } });
  });

  it('updates current and stores the previous route after router.afterEach', () => {
    const router = makeRouter(route('dashboard'));
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    router.triggerAfterEach(route('agent-detail', { id: 'agent-7' }), route('dashboard'));
    expect(store.current).toEqual({ view: 'agents', entityId: 'agent-7', refinement: null });
    store.apply({ intent: 'navigate_back' });
    expect(router.pushMock).toHaveBeenCalledWith({ name: 'dashboard', query: undefined });
  });

  it('maps every navigate_workspace target kind to its exact router.push argument', () => {
    const router = makeRouter();
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    const rows: Array<{ target: NavigateTarget; expected: RouteLocationRaw }> = [
      { target: { kind: 'card', id: 'card-1' }, expected: { name: 'card-detail', params: { id: 'card-1' }, query: undefined } },
      { target: { kind: 'transcript', id: 'session-1' }, expected: { name: 'agent-detail', params: { id: 'session-1' }, query: undefined } },
      { target: { kind: 'process', id: 'pid-1' }, expected: { name: 'process-detail', params: { id: 'pid-1' }, query: undefined } },
      { target: { kind: 'plan_diary', id: 'card-2' }, expected: { name: 'card-plan', params: { id: 'card-2' }, query: undefined } },
      { target: { kind: 'process_list' }, expected: { name: 'debug', query: undefined } },
      { target: { kind: 'agent_session_list' }, expected: { name: 'agents', query: undefined } },
      { target: { kind: 'config' }, expected: { name: 'config', query: undefined } },
    ];
    for (const row of rows) {
      store.apply({ intent: 'navigate_workspace', target: row.target });
      expect(router.pushMock).toHaveBeenLastCalledWith(row.expected);
    }
    expect(router.pushMock).toHaveBeenCalledTimes(rows.length);
  });

  it('navigate_back pops the back-stack, pushes the popped snapshot, and lets afterEach record the route being left', () => {
    const router = makeRouter(route('cards'));
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    router.triggerAfterEach(route('card-detail', { id: 'child' }), route('cards'));

    store.apply({ intent: 'navigate_back' });
    expect(router.pushMock).toHaveBeenCalledWith({ name: 'cards', query: undefined });

    router.triggerAfterEach(route('cards'), route('card-detail', { id: 'child' }));
    store.apply({ intent: 'navigate_back' });
    expect(router.pushMock).toHaveBeenLastCalledWith({ name: 'card-detail', params: { id: 'child' }, query: undefined });
  });

  it('bounds the back-stack to 16 entries', () => {
    const router = makeRouter(route('dashboard'));
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    for (let index = 0; index < 17; index += 1) {
      router.triggerAfterEach(route('card-detail', { id: `card-${index + 1}` }), route('card-detail', { id: `card-${index}` }));
    }
    store.apply({ intent: 'navigate_back' });
    expect(router.pushMock).toHaveBeenCalledWith({ name: 'card-detail', params: { id: 'card-16' }, query: undefined });
  });

  it('navigate_back on an empty stack does not push and does not throw', () => {
    const router = makeRouter();
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    expect(() => store.apply({ intent: 'navigate_back' })).not.toThrow();
    expect(router.pushMock).not.toHaveBeenCalled();
  });
});
