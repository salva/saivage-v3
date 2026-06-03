import type { CardStore } from '../cards/store-api.js';
import type { RuntimeState } from '../schemas/index.js';
import { queueSyntheticPlannerNote } from './synthetic-planner-notes.js';
import { saveRuntimeState } from './state.js';
import { cardHasBlockedPlanning } from './planning-blockers.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import {
  decideStartupActiveRunRepair,
  executeStartupActiveRunRepairDecision,
} from './startup-repair.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

function now(): string {
  return new Date().toISOString();
}

export async function repairRuntimeStartupActiveCardRun(input: {
  projectRoot: string;
  previousState: RuntimeState | null;
  cards: CardStore;
  stateMachine: RuntimeStateMachine;
  activationUnwind: ActivationUnwindRunner;
  runLedger: RuntimeRunLedger;
}): Promise<RuntimeState | null> {
  const run = input.previousState?.active_card_run ?? null;
  const card = run ? input.cards.read(run.card_id) : null;
  const persistedReview =
    card?.result && typeof card.result === 'object'
      ? (card.result as { review?: unknown }).review
      : undefined;
  const decision = decideStartupActiveRunRepair({
    previousState: input.previousState,
    card,
    hasPersistedReview: Boolean(persistedReview),
    cardHasBlockedPlanning: card ? cardHasBlockedPlanning(card) : false,
    isTerminalCardStatus: card ? TERMINAL_STATUSES.has(card.status) : false,
  });

  return executeStartupActiveRunRepairDecision({
    decision,
    previousState: input.previousState,
    effects: {
      now,
      repairOrphanActivateCardToolCalls: () => input.activationUnwind.repairOrphanActivateCardToolCalls(),
      transitionCard: (cardId, event, details) =>
        input.stateMachine.transitionCard(cardId, event, details),
      updateCard: (cardId, patch) => input.cards.update(cardId, patch),
      appendChildUnwindToolResult: (cardId, outcome, summary) =>
        input.activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
      parentPlannerRunFor: (cardId) => input.activationUnwind.parentPlannerRunFor(cardId),
      findCallerEdge: (cardId) => input.activationUnwind.findCallerEdge(cardId),
      synthesizeTerminalActivationResult: (sessionId, toolCallId, cardId) =>
        input.activationUnwind.synthesizeTerminalActivationResult(sessionId, toolCallId, cardId),
      finishOpenPlannerRun: (cardId, result) => input.runLedger.finishOpenPlannerRun(cardId, result),
      queueSyntheticPlannerNote: (note) => queueSyntheticPlannerNote(input.projectRoot, note),
      saveState: (state) => saveRuntimeState(input.projectRoot, state),
    },
  });
}
