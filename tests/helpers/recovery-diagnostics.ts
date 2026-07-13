import { RecoveryDiagnosticsStore, runActorStartupRecovery as productionRunActorStartupRecovery, type ActorRecoveryPlan, type ActorStartupRecoveryDeps } from '../../src/runtime/actors/actor-recovery.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';

const compositions = new Map<string, ReturnType<typeof createMutationLane>>();
function composition(projectRoot: string) {
  let value = compositions.get(projectRoot);
  if (!value) { value = createMutationLane(); compositions.set(projectRoot, value); }
  return value;
}

export function testRecoveryDiagnostics(projectRoot: string): RecoveryDiagnosticsStore {
  const owner = composition(projectRoot);
  const store = new RecoveryDiagnosticsStore(projectRoot, owner.lane);
  store.restabilize(owner.authority);
  return store;
}

export function writeRecoveryDiagnostics(projectRoot: string, plan: ActorRecoveryPlan, generatedAt?: string) {
  return testRecoveryDiagnostics(projectRoot).project(composition(projectRoot).authority, plan, generatedAt);
}

export function runActorStartupRecovery(plan: ActorRecoveryPlan, deps: Omit<ActorStartupRecoveryDeps, 'recoveryDiagnostics'>) {
  return productionRunActorStartupRecovery(plan, { ...deps, recoveryDiagnostics: testRecoveryDiagnostics(deps.projectRoot) });
}
