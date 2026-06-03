import type { CardStore } from '../cards/store-api.js';
import type { RuntimeState } from '../schemas/index.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import { ActivationRepairRunner } from './activation-repair.js';

export function repairRuntimeStartupActiveCardRun(input: {
  projectRoot: string;
  previousState: RuntimeState | null;
  cards: CardStore;
  stateMachine: RuntimeStateMachine;
  activationUnwind: ActivationUnwindRunner;
  runLedger: RuntimeRunLedger;
}): Promise<RuntimeState | null> {
  return new ActivationRepairRunner(input).repairStartupActiveCardRun(input.previousState);
}
