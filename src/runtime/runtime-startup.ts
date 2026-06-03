import { join } from 'node:path';
import type { CardStore } from '../cards/store-api.js';
import { PROJECT_CARD_ID } from '../cards/store-api.js';
import type { EventLogger } from '../observability/index.js';
import type { RuntimeState } from '../schemas/index.js';
import { reconcileOrphanedAgentSessions } from './session-persistence.js';
import { initRuntimeState, readRuntimeState } from './state.js';
import { acquireLock } from './lock.js';
import { reconcileProcessRecords } from './process-runner.js';
import { cardHasBlockedPlanning } from './planning-blockers.js';
import { planSweptCurrentAgentSessionPatch } from './runtime-core.js';
import { performRuntimeCrashRecovery } from './crash-recovery.js';
import { alignBlockedPlanningCardStatuses } from './startup-blocked-planning.js';
import { reconcileIdleRunningRootRuns } from './startup-run-reconciliation.js';
import {
  selectStartupPlannerRedispatchCardId,
  shouldRestartRunningIntentOnStartup,
} from './startup-repair.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import type { RuntimeProjectCommandRunner } from './runtime-project-commands.js';
import type { StuckAgentSupervisor } from '../runtime/stuck-agent-supervisor.js';
import type { RuntimeEventPublisher } from './runtime-event-publisher.js';
import type { RuntimeStateMutationPort } from './mutations.js';

function now(): string {
  return new Date().toISOString();
}

export async function performRuntimeStartup(input: {
  projectRoot: string;
  cards: CardStore;
  stateMachine: RuntimeStateMachine;
  runLedger: RuntimeRunLedger;
  projectCommands: RuntimeProjectCommandRunner;
  supervisor: StuckAgentSupervisor;
  events: RuntimeEventPublisher;
  eventLogger: EventLogger;
  mutations: RuntimeStateMutationPort;
  isRunning(): boolean;
  setPaused(paused: boolean): void;
  setRunning(running: boolean): void;
  setShuttingDown(shuttingDown: boolean): void;
  setStartupRepairPending(pending: boolean): void;
  repairStartupActiveCardRun(previousState: RuntimeState | null): Promise<RuntimeState | null>;
  dispatchGoalThroughScheduler(goalId: string): Promise<void>;
  trackBackgroundDispatch(dispatch: Promise<void>): void;
}): Promise<void> {
  if (input.isRunning()) throw new Error('Runtime is already running.');
  let state = readRuntimeState(input.projectRoot);
  if (!state) state = initRuntimeState(input.projectRoot);
  acquireLock(input.projectRoot);
  await alignBlockedPlanningCardStatuses({
    cards: input.cards,
    transitionCard: (cardId, event, details) => input.stateMachine.transitionCard(cardId, event, details),
    finishOpenPlannerRun: (goalId, result) => input.runLedger.finishOpenPlannerRun(goalId, result),
    projectRoot: input.projectRoot,
    mutations: input.mutations,
  });
  state = readRuntimeState(input.projectRoot) ?? state;
  await performRuntimeCrashRecovery({
    projectRoot: input.projectRoot,
    cards: input.cards.list(),
    transitionCard: (cardId, event) => input.stateMachine.transitionCard(cardId, event),
  });
  reconcileProcessRecords(input.projectRoot);
  input.setStartupRepairPending(true);
  const repairedState = await input.repairStartupActiveCardRun(state);
  input.setStartupRepairPending(false);
  if (!repairedState) state = initRuntimeState(input.projectRoot);
  else state = repairedState;
  const swept = reconcileOrphanedAgentSessions(join(input.projectRoot, '.saivage'));
  if (swept.length > 0) {
    const sweptSessionIds = swept.map((session) => session.id);
    input.events.emit('startup_session_sweep', { swept_session_ids: sweptSessionIds });
    input.eventLogger.appendEvent({
      kind: 'startup_session_sweep',
      swept_session_ids: sweptSessionIds,
    });
    const postRepairState = readRuntimeState(input.projectRoot);
    const patch = planSweptCurrentAgentSessionPatch({ state: postRepairState, sweptSessionIds });
    if (patch) {
      input.mutations.apply({ kind: 'patchRuntimeState', patch });
      state = readRuntimeState(input.projectRoot) ?? state;
    }
  }
  input.setPaused(state.paused);
  input.setRunning(true);
  input.setShuttingDown(false);
  input.events.emit('started', { projectRoot: input.projectRoot });
  input.eventLogger.appendEvent({ kind: 'started', project_root: input.projectRoot });
  input.supervisor.start();
  input.stateMachine.start();
  state = reconcileIdleRunningRootRuns({
    projectRoot: input.projectRoot,
    state: readRuntimeState(input.projectRoot) ?? state,
    cards: input.cards,
    eventLogger: input.eventLogger,
    mutations: input.mutations,
    now,
    publishRuntimeRun: (run) => input.events.publishRuntimeLedgerEvent('runtime_run', { run }),
  });
  if (
    shouldRestartRunningIntentOnStartup({
      state,
      projectHasBlockedPlanning: cardHasBlockedPlanning(input.cards.read(PROJECT_CARD_ID)),
    })
  ) {
    input.trackBackgroundDispatch(input.projectCommands.startProject('runtime').then(() => undefined));
  }
  const startupActiveRunCardId = state.active_card_run?.card_id ?? null;
  const startupPlannerRedispatchCardId = selectStartupPlannerRedispatchCardId({
    state,
    activeCardHasBlockedPlanning: startupActiveRunCardId
      ? cardHasBlockedPlanning(input.cards.read(startupActiveRunCardId))
      : false,
  });
  if (startupPlannerRedispatchCardId) {
    input.trackBackgroundDispatch(input.dispatchGoalThroughScheduler(startupPlannerRedispatchCardId));
  }
  setTimeout(() => {
    void input.stateMachine.requestImmediateTick();
  }, 0);
}
