import type { TypedEventEmitter } from '../events/index.js';
import type { RuntimeActivationLedgerPort } from '../contracts/index.js';
import type { EventLogger } from '../observability/index.js';
import type { RuntimeState } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import { PlannerControlExecutor } from './planner-control-executor.js';

export interface PlannerControlFactoryConfig {
  cardStore: CardStore;
  projectRoot: string;
  saivageDir: string;
  eventLogger?: EventLogger;
  runtimeStateProvider: () => RuntimeState | null;
  activationLedgerProvider: () => RuntimeActivationLedgerPort | undefined;
  eventBusProvider: () => TypedEventEmitter | undefined;
}

export function createPlannerControlExecutor(config: PlannerControlFactoryConfig): PlannerControlExecutor {
  return new PlannerControlExecutor({
    cardStore: config.cardStore,
    projectRoot: config.projectRoot,
    saivageDir: config.saivageDir,
    runtimeStateProvider: config.runtimeStateProvider,
    activationLedger: {
      readState: () => config.activationLedgerProvider()?.readState() ?? null,
      appendRun: (input) => config.activationLedgerProvider()!.appendRun(input),
      upsertActivation: (input) => config.activationLedgerProvider()!.upsertActivation(input),
    },
    eventBusProvider: config.eventBusProvider,
    eventLogger: config.eventLogger,
  });
}
