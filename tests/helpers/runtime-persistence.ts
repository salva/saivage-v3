import { RuntimeStateStore } from '../../src/runtime/state.js';
import { RecoveryDiagnosticsStore } from '../../src/runtime/actors/actor-recovery.js';
import { testActorSnapshots } from './actor-snapshots.js';
import { testMutationComposition } from './canonical-project.js';
import type { ReadModelChanges } from '../../src/application/read-model-changes.js';

export function testRuntimePersistence(projectRoot: string, changes: ReadModelChanges) {
  const composition = testMutationComposition(projectRoot);
  const runtimeState = new RuntimeStateStore(projectRoot, composition.lane, changes);
  runtimeState.restabilize(composition.authority);
  runtimeState.initialize(composition.authority);
  const recoveryDiagnostics = new RecoveryDiagnosticsStore(projectRoot, composition.lane);
  recoveryDiagnostics.restabilize(composition.authority);
  return { runtimeState, snapshots: testActorSnapshots(projectRoot, changes), recoveryDiagnostics };
}
