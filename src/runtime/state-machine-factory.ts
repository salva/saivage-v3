import { PROJECT_CARD_ID, type CardStore } from '../cards/store-api.js';
import type { ErrorLogger } from '../observability/index.js';
import { cardHasBlockedPlanning } from './planning-blockers.js';
import type { RuntimeCardPort, RuntimeStatePort } from './ports.js';
import {
  RuntimeStateMachine,
  type RuntimeScheduler,
  type RuntimeSchedulerHandle,
} from './state-machine.js';
import { readRuntimeState } from './state.js';
import type { RuntimeStateMutationPort } from './mutations.js';

export function createRuntimeStateMachine(input: {
  projectRoot: string;
  cards: CardStore;
  errorLogger: ErrorLogger;
  mutations: RuntimeStateMutationPort;
  dispatchGoalThroughScheduler(goalId: string): void;
}): RuntimeStateMachine {
  const scheduler: RuntimeScheduler = {
    setInterval: (handler, ms) => setInterval(handler, ms) as unknown as RuntimeSchedulerHandle,
    clearInterval: (handle) => clearInterval(handle as unknown as NodeJS.Timeout),
  };
  const runtimeCards: RuntimeCardPort = {
    readStatus: (cardId) => input.cards.read(cardId)?.status,
    canTransition: (from, to) => input.cards.canTransition(from, to),
    setStatus: (cardId, status) => {
      input.cards.setStatus(cardId, status);
    },
  };
  const runtimeState: RuntimeStatePort = {
    read: () => readRuntimeState(input.projectRoot),
    patch: (changes) => {
      input.mutations.apply({ kind: 'patchRuntimeState', patch: changes });
      const state = readRuntimeState(input.projectRoot);
      if (!state) throw new Error('Runtime state missing after mutation patch.');
      return state;
    },
  };
  return new RuntimeStateMachine({
    cards: runtimeCards,
    state: runtimeState,
    errors: input.errorLogger,
    clock: { now: () => new Date() },
    scheduler,
    redispatch: {
      redispatch: (cardId) => {
        if (!cardHasBlockedPlanning(input.cards.read(cardId)))
          input.dispatchGoalThroughScheduler(cardId);
      },
    },
    projectCardId: PROJECT_CARD_ID,
  });
}
