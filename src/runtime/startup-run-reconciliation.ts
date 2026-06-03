import type { CardRecord, RuntimeRunRecord, RuntimeState } from '../schemas/index.js';
import type { EventLogger } from '../observability/index.js';
import { PROJECT_CARD_ID } from '../cards/store-api.js';
import { planIdleRunningRootRunReconciliation } from './runtime-core.js';
import { readRuntimeState, updateRuntimeRun, updateRuntimeState } from './state.js';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

export function reconcileIdleRunningRootRuns(input: {
  projectRoot: string;
  state: RuntimeState;
  cards: { read(cardId: string): CardRecord | null };
  eventLogger: EventLogger;
  now(): string;
  publishRuntimeRun(run: RuntimeRunRecord): void;
}): RuntimeState {
  const projectCard = input.cards.read(PROJECT_CARD_ID);
  const projectTerminal = projectCard ? TERMINAL_STATUSES.has(projectCard.status) : false;
  const plan = planIdleRunningRootRunReconciliation({
    state: input.state,
    projectTerminal,
    nowIso: input.now(),
  });
  if (!plan) return input.state;
  let reconciled = input.state;
  for (const update of plan.runUpdates) {
    const updated = updateRuntimeRun(input.projectRoot, update.runId, update.updates);
    if (updated) {
      input.publishRuntimeRun(updated);
      reconciled = readRuntimeState(input.projectRoot) ?? reconciled;
    }
  }
  if (plan.statePatch) {
    updateRuntimeState(input.projectRoot, plan.statePatch);
    reconciled = readRuntimeState(input.projectRoot) ?? reconciled;
  }
  input.eventLogger.appendEvent({
    kind: 'runtime_diagnostic',
    phase: 'startup',
    error_message: plan.diagnosticMessage,
  });
  return readRuntimeState(input.projectRoot) ?? reconciled;
}
