import { createMutationLane } from '../../src/application/mutation-lane.js';
import { RuntimeStateStore } from '../../src/runtime/state.js';
import type { RuntimeState } from '../../src/schemas/index.js';

const stores = new Map<string, { store: RuntimeStateStore; authority: ReturnType<typeof createMutationLane>['authority'] }>();

export function testRuntimeStateStore(projectRoot: string) {
  let entry = stores.get(projectRoot);
  if (!entry) {
    const composition = createMutationLane();
    const store = new RuntimeStateStore(projectRoot, composition.lane);
    store.restabilize(composition.authority);
    entry = { store, authority: composition.authority };
    stores.set(projectRoot, entry);
  }
  return entry;
}

export function initRuntimeState(projectRoot: string): RuntimeState {
  const { store, authority } = testRuntimeStateStore(projectRoot);
  return store.initialize(authority);
}

export function saveRuntimeState(projectRoot: string, state: RuntimeState): RuntimeState {
  const { store, authority } = testRuntimeStateStore(projectRoot);
  return store.replace(authority, state);
}

export function updateRuntimeState(projectRoot: string, patch: Partial<RuntimeState>): RuntimeState {
  const { store, authority } = testRuntimeStateStore(projectRoot);
  if (!store.read()) store.initialize(authority);
  return store.patch(authority, patch);
}
