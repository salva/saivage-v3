import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { RouteLocationNormalizedLoaded, RouteLocationRaw, Router } from 'vue-router';

const BACK_STACK_LIMIT = 16;

export type WorkspaceView = 'dashboard' | 'cards' | 'agents' | 'files' | 'debug' | 'config' | null;

export interface WorkspaceContext {
  view: WorkspaceView;
  entityId: string | null;
  refinement: Record<string, string> | null;
}

export type NavigateTargetKind =
  | 'card'
  | 'transcript'
  | 'process'
  | 'plan_diary'
  | 'process_list'
  | 'agent_session_list'
  | 'config';

export interface NavigateTarget {
  kind: NavigateTargetKind;
  id?: string;
  refinement?: string;
}

export type WorkspaceNavigationIntent =
  | { intent: 'navigate_workspace'; target: NavigateTarget }
  | { intent: 'navigate_back' };

function emptyContext(): WorkspaceContext {
  return { view: null, entityId: null, refinement: null };
}

function firstParam(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function queryToRefinement(query: RouteLocationNormalizedLoaded['query']): Record<string, string> | null {
  const refinement: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    refinement[key] = Array.isArray(value) ? value.map(String).join(',') : String(value);
  }
  return Object.keys(refinement).length > 0 ? refinement : null;
}

function refinementToQuery(refinement: Record<string, string> | null): Record<string, string> | undefined {
  if (!refinement || Object.keys(refinement).length === 0) return undefined;
  return { ...refinement };
}

function refinementStringToQuery(refinement?: string): Record<string, string> | undefined {
  if (!refinement) return undefined;
  return { refinement };
}

function snapshotFromRoute(route: RouteLocationNormalizedLoaded): WorkspaceContext {
  const routeName = typeof route.name === 'string' ? route.name : null;
  const id = firstParam(route.params.id);
  const refinement = queryToRefinement(route.query);

  switch (routeName) {
    case 'dashboard':
      return { view: 'dashboard', entityId: null, refinement };
    case 'cards':
      return { view: 'cards', entityId: null, refinement };
    case 'card-detail':
    case 'card-plan':
      return { view: 'cards', entityId: id, refinement };
    case 'agents':
      return { view: 'agents', entityId: null, refinement };
    case 'agent-detail':
      return { view: 'agents', entityId: id, refinement };
    case 'files':
      return { view: 'files', entityId: typeof route.query.path === 'string' ? route.query.path : null, refinement };
    case 'debug':
      return { view: 'debug', entityId: typeof route.query.process === 'string' ? route.query.process : null, refinement };
    case 'process-detail':
      return { view: 'debug', entityId: id, refinement };
    case 'config':
      return { view: 'config', entityId: null, refinement };
    default:
      return emptyContext();
  }
}

function routeForSnapshot(snapshot: WorkspaceContext): RouteLocationRaw {
  const query = refinementToQuery(snapshot.refinement);
  if (snapshot.view === 'cards') {
    return snapshot.entityId
      ? { name: 'card-detail', params: { id: snapshot.entityId }, query }
      : { name: 'cards', query };
  }
  if (snapshot.view === 'agents') {
    return snapshot.entityId
      ? { name: 'agent-detail', params: { id: snapshot.entityId }, query }
      : { name: 'agents', query };
  }
  if (snapshot.view === 'files') {
    return snapshot.entityId
      ? { name: 'files', query: { ...(query ?? {}), path: snapshot.entityId } }
      : { name: 'files', query };
  }
  if (snapshot.view === 'debug') {
    return snapshot.entityId
      ? { name: 'process-detail', params: { id: snapshot.entityId }, query }
      : { name: 'debug', query };
  }
  if (snapshot.view === 'config') return { name: 'config', query };
  return { name: 'dashboard', query };
}

function routeForTarget(target: NavigateTarget): RouteLocationRaw {
  switch (target.kind) {
    case 'card':
      return { name: 'card-detail', params: { id: target.id ?? '' }, query: refinementStringToQuery(target.refinement) };
    case 'transcript':
      return { name: 'agent-detail', params: { id: target.id ?? '' }, query: refinementStringToQuery(target.refinement) };
    case 'process':
      return { name: 'process-detail', params: { id: target.id ?? '' }, query: refinementStringToQuery(target.refinement) };
    case 'plan_diary':
      return { name: 'card-plan', params: { id: target.id ?? '' }, query: refinementStringToQuery(target.refinement) };
    case 'process_list':
      return { name: 'debug', query: refinementStringToQuery(target.refinement) };
    case 'agent_session_list':
      return { name: 'agents', query: refinementStringToQuery(target.refinement) };
    case 'config':
      return { name: 'config', query: refinementStringToQuery(target.refinement) };
  }
}

export const useWorkspaceRouteStore = defineStore('workspace-route', () => {
  const view = ref<WorkspaceView>(null);
  const entityId = ref<string | null>(null);
  const refinement = ref<Record<string, string> | null>(null);
  const backStack = ref<WorkspaceContext[]>([]);
  const currentRouter = ref<Router | null>(null);
  const registered = ref(false);
  let skipNextBackStackPush = false;

  const current = computed<WorkspaceContext>(() => ({
    view: view.value,
    entityId: entityId.value,
    refinement: refinement.value ? { ...refinement.value } : null,
  }));

  function setFromSnapshot(snapshot: WorkspaceContext): void {
    view.value = snapshot.view;
    entityId.value = snapshot.entityId;
    refinement.value = snapshot.refinement ? { ...snapshot.refinement } : null;
  }

  function pushBackStack(snapshot: WorkspaceContext): void {
    backStack.value = [...backStack.value, {
      view: snapshot.view,
      entityId: snapshot.entityId,
      refinement: snapshot.refinement ? { ...snapshot.refinement } : null,
    }].slice(-BACK_STACK_LIMIT);
  }

  function registerRouterListener(router: Router): void {
    currentRouter.value = router;
    setFromSnapshot(snapshotFromRoute(router.currentRoute.value));
    if (registered.value) return;
    registered.value = true;
    router.afterEach((to, from) => {
      const previous = snapshotFromRoute(from);
      if (skipNextBackStackPush) {
        skipNextBackStackPush = false;
      } else {
        pushBackStack(previous);
      }
      setFromSnapshot(snapshotFromRoute(to));
    });
  }

  function apply(intent: WorkspaceNavigationIntent): void {
    const router = currentRouter.value;
    if (!router) return;
    if (intent.intent === 'navigate_workspace') {
      void router.push(routeForTarget(intent.target));
      return;
    }
    const previous = backStack.value[backStack.value.length - 1];
    if (!previous) return;
    backStack.value = backStack.value.slice(0, -1);
    skipNextBackStackPush = true;
    void router.push(routeForSnapshot(previous));
  }

  return {
    view,
    entityId,
    refinement,
    current,
    registerRouterListener,
    apply,
  };
});
