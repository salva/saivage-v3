import type { AgentExecutionPort } from '../contracts/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { StuckAgentSupervisor } from '../runtime/stuck-agent-supervisor.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import { performRuntimeCrashRecovery } from './crash-recovery.js';
import type { RuntimeDiagnostics } from './runtime-diagnostics.js';
import type { RuntimeEventPublisher } from './runtime-event-publisher.js';
import type { RuntimeLifecycleState } from './runtime-lifecycle-state.js';
import type { RuntimeProjectCommandRunner } from './runtime-project-commands.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import { performRuntimeShutdown } from './runtime-shutdown.js';
import { performRuntimeStartup } from './runtime-startup.js';
import { repairRuntimeStartupActiveCardRun } from './runtime-startup-active-run-repair.js';
import type { ActivationScheduler } from './scheduler.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeStateMutationPort } from './mutations.js';

export class RuntimeLifecycleController {
  constructor(
    private readonly deps: {
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
      lifecycle: RuntimeLifecycleState;
      activationUnwind: ActivationUnwindRunner;
      activationScheduler: ActivationScheduler;
    },
  ) {}

  async start(): Promise<void> {
    await performRuntimeStartup({
      projectRoot: this.deps.projectRoot,
      cards: this.deps.cards,
      stateMachine: this.deps.stateMachine,
      runLedger: this.deps.runLedger,
      projectCommands: this.deps.projectCommands,
      supervisor: this.deps.supervisor,
      events: this.deps.events,
      eventLogger: this.deps.eventLogger,
      mutations: this.deps.mutations,
      lifecycle: this.deps.lifecycle,
      repairStartupActiveCardRun: (previousState) =>
        repairRuntimeStartupActiveCardRun({
          projectRoot: this.deps.projectRoot,
          previousState,
          cards: this.deps.cards,
          stateMachine: this.deps.stateMachine,
          activationUnwind: this.deps.activationUnwind,
          runLedger: this.deps.runLedger,
          mutations: this.deps.mutations,
        }),
      dispatchGoalThroughScheduler: (goalId) => this.deps.activationScheduler.dispatch(goalId),
      trackBackgroundDispatch: (dispatch) => this.deps.diagnostics.trackBackgroundDispatch(dispatch),
    });
  }

  async shutdown(): Promise<void> {
    await performRuntimeShutdown({
      projectRoot: this.deps.projectRoot,
      cards: this.deps.cards,
      agentRuntime: this.deps.agentRuntime,
      supervisor: this.deps.supervisor,
      stateMachine: this.deps.stateMachine,
      diagnostics: this.deps.diagnostics,
      mutations: this.deps.mutations,
      eventLogger: this.deps.eventLogger,
      errorLogger: this.deps.errorLogger,
      ownsEventLogger: this.deps.ownsEventLogger,
      ownsErrorLogger: this.deps.ownsErrorLogger,
      lifecycle: this.deps.lifecycle,
      emitShutdown: () => this.deps.events.emit('shutdown'),
    });
  }

  async performCrashRecovery(): Promise<void> {
    await performRuntimeCrashRecovery({
      projectRoot: this.deps.projectRoot,
      cards: this.deps.cards.list(),
      transitionCard: (cardId, event) => this.deps.stateMachine.transitionCard(cardId, event),
    });
  }

  requestImmediateTick(): Promise<void> {
    return this.deps.stateMachine.requestImmediateTick();
  }
}
