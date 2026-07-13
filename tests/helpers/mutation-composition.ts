import { createMutationLane } from '../../src/application/mutation-lane.js';
import { AuthProfileRepository } from '../../src/auth/auth-profile-store.js';

export function createTestMutationComposition() {
  return createMutationLane();
}

export function createTestAuthProfileRepository(projectRoot: string) {
  const mutation = createMutationLane();
  const repository = new AuthProfileRepository(projectRoot, mutation.lane);
  repository.restabilize(mutation.authority);
  return { repository, authority: mutation.authority, lane: mutation.lane };
}
