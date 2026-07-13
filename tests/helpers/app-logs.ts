import { AppLogStore } from '../../src/persistence/app-log.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';

const stores = new Map<string, { store: AppLogStore; authority: import('../../src/application/mutation-authority.js').CompositionMutationAuthority }>();

export function testAppLogs(projectRoot: string): AppLogStore {
  const existing = stores.get(projectRoot);
  if (existing) return existing.store;
  const mutation = createMutationLane();
  const store = new AppLogStore(projectRoot, mutation.lane);
  store.restabilize(mutation.authority);
  stores.set(projectRoot, { store, authority: mutation.authority });
  return store;
}

export function testAppLogAuthority(projectRoot: string) {
  testAppLogs(projectRoot);
  return stores.get(projectRoot)!.authority;
}
