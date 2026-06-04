import type { CardStore } from '../cards/store-api.js';
import type { ActivationCompletionOutcome, RuntimeState } from '../schemas/index.js';
import { queueSyntheticPlannerNote } from './synthetic-planner-notes.js';
import { cardHasBlockedPlanning } from './planning-blockers.js';
import {
  decideStartupActiveRunRepair,
  executeStartupActiveRunRepairDecision,
  rehydrateStartupActivation,
} from './startup-repair.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import type { RuntimeStateMutationPort } from './mutations.js';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

function now(): string {
  return new Date().toISOString();
}

export interface ActivationRepairUnwindPort {
  repairOrphanActivateCardToolCalls(): void;
  appendChildUnwindToolResult(cardId: string, outcome: ActivationCompletionOutcome, summary: string): void;
  parentPlannerRunFor(cardId: string): RuntimeState['active_card_run'];
  findCallerEdge(cardId: string): { callerSessionId: string; callerToolCallId: string } | null;
  synthesizeTerminalActivationResult(sessionId: string, toolCallId: string, cardId: string): boolean;
}

export class ActivationRepairRunner {
  constructor(
    private readonly deps: {
      projectRoot: string;
      cards: CardStore;
      stateMachine: RuntimeStateMachine;
      activationUnwind: ActivationRepairUnwindPort;
      runLedger: RuntimeRunLedger;
      mutations: RuntimeStateMutationPort;
    },
  ) {}

  repairStartupActiveCardRun(previousState: RuntimeState | null): Promise<RuntimeState | null> {
    const run = rehydrateStartupActivation(previousState)?.run ?? null;
    const card = run ? this.deps.cards.read(run.card_id) : null;
    const persistedReview = card?.lifecycle.result?.kind === 'reviewer_pass' ? card.lifecycle.result : undefined;
    const decision = decideStartupActiveRunRepair({
      previousState,
      card,
      hasPersistedReview: Boolean(persistedReview),
      cardHasBlockedPlanning: card ? cardHasBlockedPlanning(card) : false,
      isTerminalCardStatus: card ? TERMINAL_STATUSES.has(card.status) : false,
    });

    return executeStartupActiveRunRepairDecision({
      decision,
      previousState,
      effects: {
        now,
        repairOrphanActivateCardToolCalls: () => this.deps.activationUnwind.repairOrphanActivateCardToolCalls(),
        transitionCard: (cardId, event, details) =>
          this.deps.stateMachine.transitionCard(cardId, event, details),
        repairTerminalLifecycle: (cardId, patch) => this.deps.cards.repairTerminalLifecycle(cardId, patch),
        appendChildUnwindToolResult: (cardId, outcome, summary) =>
          this.deps.activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
        parentPlannerRunFor: (cardId) => this.deps.activationUnwind.parentPlannerRunFor(cardId),
        findCallerEdge: (cardId) => this.deps.activationUnwind.findCallerEdge(cardId),
        synthesizeTerminalActivationResult: (sessionId, toolCallId, cardId) =>
          this.deps.activationUnwind.synthesizeTerminalActivationResult(sessionId, toolCallId, cardId),
        finishOpenPlannerRun: (cardId, result) => this.deps.runLedger.finishOpenPlannerRun(cardId, result),
        queueSyntheticPlannerNote: (note) => queueSyntheticPlannerNote(this.deps.projectRoot, note),
        saveState: (state) => {
          this.deps.mutations.apply({ kind: 'replaceRuntimeState', state });
          return state;
        },
      },
    });
  }
}
