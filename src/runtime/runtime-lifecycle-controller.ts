import type { AgentExecutionPort } from '../contracts/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { StuckAgentSupervisor } from '../runtime/stuck-agent-supervisor.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import { ActivationRepairRunner } from './activation-repair.js';
import { performRuntimeCrashRecovery } from './crash-recovery.js';
import type { RuntimeDiagnostics } from './runtime-diagnostics.js';
import type { RuntimeEventPublisher } from './runtime-event-publisher.js';
import type { LifecycleFlags } from './runtime-lifecycle-state.js';
import type { RuntimeProjectCommandRunner } from './runtime-project-commands.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import { performRuntimeShutdown } from './runtime-shutdown.js';
import { performRuntimeStartup } from './runtime-startup.js';
import type { RuntimePlannerDispatcher } from './runtime-planner-dispatcher.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeStateMutationPort } from './mutations.js';

export interface RuntimeLifecycleController {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  performCrashRecovery(): Promise<void>;
  requestImmediateTick(): Promise<void>;
}

export function createRuntimeLifecycleController(
  deps: {
      projectRoot: string;
      cards: CardStore;
      agentRuntime: AgentExecutionPort;
      supervisor: StuckAgentSupervisor;
      stateMachine: RuntimeStateMachine;
      runLedger: RuntimeRunLedger;
      projectCommands: RuntimeProjectCommandRunner;
      events: RuntimeEventPublisher;
      eventLogger: EventLogger;
      errorLogger: ErrorLogger;
      ownsEventLogger: boolean;
      ownsErrorLogger: boolean;
      diagnostics: RuntimeDiagnostics;
      mutations: RuntimeStateMutationPort;
      lifecycle: LifecycleFlags;
      activationUnwind: ActivationUnwindRunner;
      plannerDispatcher: RuntimePlannerDispatcher;
  },
): RuntimeLifecycleController {
  return {
    async start(): Promise<void> {
    await performRuntimeStartup({
      projectRoot: deps.projectRoot,
      cards: deps.cards,
      stateMachine: deps.stateMachine,
      runLedger: deps.runLedger,
      projectCommands: deps.projectCommands,
      supervisor: deps.supervisor,
      events: deps.events,
      eventLogger: deps.eventLogger,
      mutations: deps.mutations,
      lifecycle: deps.lifecycle,
      repairStartupActiveCardRun: (previousState) =>
        new ActivationRepairRunner({
          projectRoot: deps.projectRoot,
          cards: deps.cards,
          stateMachine: deps.stateMachine,
          activationUnwind: deps.activationUnwind,
          runLedger: deps.runLedger,
          mutations: deps.mutations,
        }).repairStartupActiveCardRun(previousState),
      dispatchGoalThroughScheduler: (goalId) => deps.plannerDispatcher.dispatchGoal(goalId),
      trackBackgroundDispatch: (dispatch) => deps.diagnostics.trackBackgroundDispatch(dispatch),
    });
    },

    async shutdown(): Promise<void> {
    await performRuntimeShutdown({
      projectRoot: deps.projectRoot,
      cards: deps.cards,
      agentRuntime: deps.agentRuntime,
      supervisor: deps.supervisor,
      stateMachine: deps.stateMachine,
      diagnostics: deps.diagnostics,
      mutations: deps.mutations,
      eventLogger: deps.eventLogger,
      errorLogger: deps.errorLogger,
      ownsEventLogger: deps.ownsEventLogger,
      ownsErrorLogger: deps.ownsErrorLogger,
      lifecycle: deps.lifecycle,
      emitShutdown: () => deps.events.emit('shutdown'),
    });
    },

    async performCrashRecovery(): Promise<void> {
    await performRuntimeCrashRecovery({
      projectRoot: deps.projectRoot,
      cards: deps.cards.list(),
      transitionCard: (cardId, event) => deps.stateMachine.transitionCard(cardId, event),
    });
    },

    requestImmediateTick(): Promise<void> {
    return deps.stateMachine.requestImmediateTick();
    },
  };
}
