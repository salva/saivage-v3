import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import { AuthProfileRepository } from '../../src/auth/auth-profile-store.js';

export function createTestMutationComposition() {
  return new ApplicationPersistenceHealth();
}

export function createTestAuthProfileRepository(projectRoot: string) {
  const health = new ApplicationPersistenceHealth();
  const repository = new AuthProfileRepository(projectRoot, health);
  repository.restabilize();
  return { repository, health };
}
