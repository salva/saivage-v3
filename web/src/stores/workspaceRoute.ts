import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { RouteLocationNormalizedLoaded, RouteLocationRaw, Router } from 'vue-router';
import { parseAgentDetailRouteParam } from '../router/agent-session-route';
import type { WorkspaceNavigationIntent, WorkspaceNavigationTarget } from '../api/contracts';

const BACK_STACK_LIMIT = 16;

type WorkspaceView = 'cockpit' | 'files' | 'system' | null;

interface WorkspaceContext {
  view: WorkspaceView;
  entityId: string | null;
  refinement: Record<string, string> | null;
  routeName: string | null;
}

function emptyContext(): WorkspaceContext {
  return { view: null, entityId: null, refinement: null, routeName: null };
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
    case 'home':
      return { view: 'cockpit', entityId: null, refinement, routeName };
    case 'cards':
      return { view: 'cockpit', entityId: null, refinement, routeName };
    case 'card-detail':
      return { view: 'cockpit', entityId: id, refinement, routeName };
    case 'agent-detail':
      {
        const parsed = parseAgentDetailRouteParam(route.params.id);
        return { view: 'cockpit', entityId: parsed.kind === 'valid' ? parsed.sessionId : null, refinement, routeName };
      }
    case 'files':
      return { view: 'files', entityId: typeof route.query.path === 'string' ? route.query.path : null, refinement, routeName };
    case 'system':
      return { view: 'system', entityId: typeof route.query.process === 'string' ? route.query.process : null, refinement, routeName };
    default:
      return emptyContext();
  }
}

function routeForSnapshot(snapshot: WorkspaceContext): RouteLocationRaw {
  const query = refinementToQuery(snapshot.refinement);
  if (snapshot.routeName === 'cards') return { name: 'cards', query };
  if (snapshot.view === 'cockpit') {
    if (snapshot.entityId) {
      const parsed = parseAgentDetailRouteParam(snapshot.entityId);
      if (parsed.kind === 'valid') return { name: 'agent-detail', params: { id: parsed.sessionId }, query };
      return { name: 'card-detail', params: { id: snapshot.entityId }, query };
    }
    return { name: 'home', query };
  }
  if (snapshot.view === 'files') {
    return snapshot.entityId
      ? { name: 'files', query: { ...(query ?? {}), path: snapshot.entityId } }
      : { name: 'files', query };
  }
  if (snapshot.view === 'system') {
    return snapshot.entityId
      ? { name: 'system', query: { ...(query ?? {}), section: 'processes', process: snapshot.entityId } }
      : { name: 'system', query };
  }
  return { name: 'home', query };
}

function routeForTarget(target: WorkspaceNavigationTarget): RouteLocationRaw | null {
  switch (target.kind) {
    case 'card':
      return { name: 'card-detail', params: { id: target.id ?? '' }, query: refinementStringToQuery(target.refinement) };
    case 'transcript':
      {
        const parsed = parseAgentDetailRouteParam(target.id);
        return parsed.kind === 'valid' ? { name: 'agent-detail', params: { id: parsed.sessionId }, query: refinementStringToQuery(target.refinement) } : null;
      }
    case 'process':
      return { name: 'system', query: { ...(refinementStringToQuery(target.refinement) ?? {}), section: 'processes', process: target.id ?? '' } };
    case 'process_list':
      return { name: 'system', query: { ...(refinementStringToQuery(target.refinement) ?? {}), section: 'processes' } };
    case 'agent_session_list':
      return { name: 'system', query: { ...(refinementStringToQuery(target.refinement) ?? {}), section: 'participants' } };
  }
}

export const useWorkspaceRouteStore = defineStore('workspace-route', () => {
  const view = ref<WorkspaceView>(null);
  const entityId = ref<string | null>(null);
  const refinement = ref<Record<string, string> | null>(null);
  const routeName = ref<string | null>(null);
  const backStack = ref<WorkspaceContext[]>([]);
  const currentRouter = ref<Router | null>(null);
  const registered = ref(false);
  let restoring = false;

  const current = computed<WorkspaceContext>(() => ({
    view: view.value,
    entityId: entityId.value,
    refinement: refinement.value ? { ...refinement.value } : null,
    routeName: routeName.value,
  }));

  function setFromSnapshot(snapshot: WorkspaceContext): void {
    view.value = snapshot.view;
    entityId.value = snapshot.entityId;
    refinement.value = snapshot.refinement ? { ...snapshot.refinement } : null;
    routeName.value = snapshot.routeName;
  }

  function pushBackStack(snapshot: WorkspaceContext): void {
    backStack.value = [...backStack.value, {
      view: snapshot.view,
      entityId: snapshot.entityId,
      refinement: snapshot.refinement ? { ...snapshot.refinement } : null,
      routeName: snapshot.routeName,
    }].slice(-BACK_STACK_LIMIT);
  }

  function registerRouterListener(router: Router): void {
    currentRouter.value = router;
    setFromSnapshot(snapshotFromRoute(router.currentRoute.value));
    if (registered.value) return;
    registered.value = true;
    router.afterEach((to, from) => {
      if (!restoring) pushBackStack(snapshotFromRoute(from));
      restoring = false;
      setFromSnapshot(snapshotFromRoute(to));
    });
  }

  function apply(intent: WorkspaceNavigationIntent): void {
    const router = currentRouter.value;
    if (!router) return;
    if (intent.intent === 'navigate_workspace') {
      const target = routeForTarget(intent.target);
      if (target) void router.push(target);
      return;
    }
    const previous = backStack.value[backStack.value.length - 1];
    if (!previous) return;
    backStack.value = backStack.value.slice(0, -1);
    restoring = true;
    void router.replace(routeForSnapshot(previous));
  }

  return {
    view,
    entityId,
    refinement,
    routeName,
    current,
    registerRouterListener,
    apply,
  };
});
