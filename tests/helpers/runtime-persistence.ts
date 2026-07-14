import { RuntimeStateStore } from '../../src/runtime/state.js';
import { RecoveryDiagnosticsStore } from '../../src/runtime/actors/actor-recovery.js';
import { testActorSnapshots } from './actor-snapshots.js';
import { testPersistenceHealth } from './canonical-project.js';
import type { ReadModelChanges } from '../../src/application/read-model-changes.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';

export function testRuntimePersistence(projectRoot: string, changes: ReadModelChanges) {
  const health = testPersistenceHealth(projectRoot);
  const runtimeState = new RuntimeStateStore(projectRoot, health, changes);
  runtimeState.restabilize();
  runtimeState.initialize();
  const recoveryDiagnostics = new RecoveryDiagnosticsStore(projectRoot, health);
  recoveryDiagnostics.restabilize();
  return { runtimeState, snapshots: testActorSnapshots(projectRoot, changes), recoveryDiagnostics, persistenceHealth: health, interventionBinding: new RuntimeInterventionBinding() };
}
