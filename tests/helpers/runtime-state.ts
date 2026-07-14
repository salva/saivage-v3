import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import { RuntimeStateStore } from '../../src/runtime/state.js';
import type { RuntimeState } from '../../src/schemas/index.js';

const stores = new Map<string, { store: RuntimeStateStore; health: ApplicationPersistenceHealth }>();

export function testRuntimeStateStore(projectRoot: string) {
  let entry = stores.get(projectRoot);
  if (!entry) {
    const health = new ApplicationPersistenceHealth();
    const store = new RuntimeStateStore(projectRoot, health);
    store.restabilize();
    entry = { store, health };
    stores.set(projectRoot, entry);
  }
  return entry;
}

export function initRuntimeState(projectRoot: string): RuntimeState {
  const { store } = testRuntimeStateStore(projectRoot);
  return store.initialize();
}

export function saveRuntimeState(projectRoot: string, state: RuntimeState): RuntimeState {
  const { store } = testRuntimeStateStore(projectRoot);
  return store.replace(state);
}

export function updateRuntimeState(projectRoot: string, patch: Partial<RuntimeState>): RuntimeState {
  const { store } = testRuntimeStateStore(projectRoot);
  if (!store.read()) store.initialize();
  return store.patch(patch);
}
