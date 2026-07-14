import { RecoveryDiagnosticsStore, runActorStartupRecovery as productionRunActorStartupRecovery, type ActorRecoveryPlan, type ActorStartupRecoveryDeps } from '../../src/runtime/actors/actor-recovery.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';

const compositions = new Map<string, ApplicationPersistenceHealth>();
function composition(projectRoot: string) {
  let value = compositions.get(projectRoot);
  if (!value) { value = new ApplicationPersistenceHealth(); compositions.set(projectRoot, value); }
  return value;
}

export function testRecoveryDiagnostics(projectRoot: string): RecoveryDiagnosticsStore {
  const owner = composition(projectRoot);
  const store = new RecoveryDiagnosticsStore(projectRoot, owner);
  store.restabilize();
  return store;
}

export function writeRecoveryDiagnostics(projectRoot: string, plan: ActorRecoveryPlan, generatedAt?: string) {
  return testRecoveryDiagnostics(projectRoot).project(plan, generatedAt);
}

export function runActorStartupRecovery(plan: ActorRecoveryPlan, deps: Omit<ActorStartupRecoveryDeps, 'recoveryDiagnostics'>) {
  return productionRunActorStartupRecovery(plan, { ...deps, recoveryDiagnostics: testRecoveryDiagnostics(deps.projectRoot) });
}
