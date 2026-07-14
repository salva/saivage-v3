import { AppLogStore } from '../../src/persistence/app-log.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';

const stores = new Map<string, { store: AppLogStore; health: ApplicationPersistenceHealth }>();

export function testAppLogs(projectRoot: string): AppLogStore {
  const existing = stores.get(projectRoot);
  if (existing) return existing.store;
  const health = new ApplicationPersistenceHealth();
  const store = new AppLogStore(projectRoot, health);
  store.restabilize();
  stores.set(projectRoot, { store, health });
  return store;
}

export function testAppLogHealth(projectRoot: string) {
  testAppLogs(projectRoot);
  return stores.get(projectRoot)!.health;
}
