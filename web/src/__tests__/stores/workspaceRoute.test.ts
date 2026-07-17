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

function makeRouter(initial = route('dashboard')): Router & { pushMock: ReturnType<typeof vi.fn>; replaceMock: ReturnType<typeof vi.fn>; triggerAfterEach: (to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) => void } {
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
    expect(store.current).toEqual({ view: 'cards', entityId: '11111111-1111-4111-8111-111111111111', refinement: { tab: 'history' } });
  });

  it('updates current and stores the previous route after router.afterEach', () => {
    const router = makeRouter(route('dashboard'));
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    router.triggerAfterEach(route('agent-detail', { id: 'planner:project' }), route('dashboard'));
    expect(store.current).toEqual({ view: 'agents', entityId: 'planner:project', refinement: null });
    store.apply({ intent: 'navigate_back' });
    expect(router.replaceMock).toHaveBeenCalledWith({ name: 'dashboard', query: undefined });
  });

  it('maps every navigate_workspace target kind to its exact router.push argument', () => {
    const router = makeRouter();
    const store = useWorkspaceRouteStore();
    store.registerRouterListener(router);
    const rows: Array<{ target: NavigateTarget; expected: RouteLocationRaw }> = [
      { target: { kind: 'card', id: '11111111-1111-4111-8111-111111111111' }, expected: { name: 'card-detail', params: { id: '11111111-1111-4111-8111-111111111111' }, query: undefined } },
      { target: { kind: 'transcript', id: 'planner:project' }, expected: { name: 'agent-detail', params: { id: 'planner:project' }, query: undefined } },
      { target: { kind: 'process', id: 'pid-1' }, expected: { name: 'process-detail', params: { id: 'pid-1' }, query: undefined } },
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
    const router = makeRouter(route('dashboard'));
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
});
