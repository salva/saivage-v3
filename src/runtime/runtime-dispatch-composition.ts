import type { CardStore } from '../cards/store-api.js';
import type { AgentExecutionPort } from '../contracts/index.js';
import type { SessionStamper } from '../contracts/session-stamper.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import { ExecutorActivationDispatcher } from './executor-activation-dispatcher.js';
import { PendingActivationDispatcher } from './pending-activation-dispatcher.js';
import { PlannerFailureHandler } from './phases/planner-failure-handler.js';
import { RuntimeCardDispatcher } from './runtime-card-dispatcher.js';
import type { RuntimeDiagnostics } from './runtime-diagnostics.js';
import type { RuntimeEventPublisher } from './runtime-event-publisher.js';
import type { RuntimeConfig, RuntimeSkillsPort } from './runtime-config.js';
import { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import type { RuntimeLifecycleState } from './runtime-lifecycle-state.js';
import { RuntimePauseResumeController } from './runtime-pause-resume.js';
import { RuntimePlannerDispatcher } from './runtime-planner-dispatcher.js';
import { RuntimeProjectCommandRunner } from './runtime-project-commands.js';
import { RuntimeReviewerDispatcher } from './runtime-reviewer-dispatcher.js';
import { RuntimeRunLedger } from './runtime-run-ledger.js';
import { ActivationScheduler } from './scheduler.js';
import { createRuntimeStateMachine } from './state-machine-factory.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeStateMutationPort } from './mutations.js';

export interface RuntimeDispatchCollaborators {
  activationScheduler: ActivationScheduler;
  stateMachine: RuntimeStateMachine;
  projectCommands: RuntimeProjectCommandRunner;
  pauseResume: RuntimePauseResumeController;
  executorActivations: ExecutorActivationDispatcher;
  pendingActivations: PendingActivationDispatcher;
  reviewerDispatcher: RuntimeReviewerDispatcher;
  plannerDispatcher: RuntimePlannerDispatcher;
  cardDispatcher: RuntimeCardDispatcher;
}

export function createRuntimeDispatchCollaborators(input: {
  projectRoot: string;
  config: RuntimeConfig;
  cards: CardStore;
  agentRuntime: AgentExecutionPort;
  getSkillsEngine(): RuntimeSkillsPort | null;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  events: RuntimeEventPublisher;
  diagnostics: RuntimeDiagnostics;
  mutations: RuntimeStateMutationPort;
  lifecycle: RuntimeLifecycleState;
  sessionStamper: SessionStamper;
  activationUnwind: ActivationUnwindRunner;
  goalContext: RuntimeGoalContextCoordinator;
  runLedger: RuntimeRunLedger;
  now(): string;
}): RuntimeDispatchCollaborators {
  let cardDispatcher!: RuntimeCardDispatcher;
  const activationScheduler = new ActivationScheduler(
    input.config.goalDispatcher,
    (goalId) => cardDispatcher.dispatchGoal(goalId),
  );
  const stateMachine = createRuntimeStateMachine({
    projectRoot: input.projectRoot,
    cards: input.cards,
    errorLogger: input.errorLogger,
    mutations: input.mutations,
    dispatchGoalThroughScheduler: (cardId) => {
      void activationScheduler.dispatch(cardId);
    },
  });
  const projectCommands = new RuntimeProjectCommandRunner({
    projectRoot: input.projectRoot,
    cards: input.cards,
    agentRuntime: input.agentRuntime,
    eventLogger: input.eventLogger,
    sessionStamper: input.sessionStamper,
    stateMachine,
    mutations: input.mutations,
    lifecycle: input.lifecycle,
    now: input.now,
    publishRuntimeCommand: (command) => input.events.publishRuntimeLedgerEvent('runtime_command', { command }),
    publishRuntimeRun: (run) => input.events.publishRuntimeLedgerEvent('runtime_run', { run }),
    publishActionableError: (error) =>
      input.events.publishRuntimeLedgerEvent('runtime_actionable_error', { actionable_error: error }),
    trackBackgroundDispatch: (dispatch) => input.diagnostics.trackBackgroundDispatch(dispatch),
    dispatchGoalThroughScheduler: (goalId) => activationScheduler.dispatch(goalId),
  });
  const pauseResume = new RuntimePauseResumeController({
    projectRoot: input.projectRoot,
    eventLogger: input.eventLogger,
    stateMachine,
    goalContext: input.goalContext,
    mutations: input.mutations,
    lifecycle: input.lifecycle,
    emit: (eventName, data) => input.events.emit(eventName, data),
    now: input.now,
  });
  const executorActivations = new ExecutorActivationDispatcher({
    projectRoot: input.projectRoot,
    cards: input.cards,
    agentRuntime: input.agentRuntime,
    skillsEngine: input.getSkillsEngine(),
    stateMachine,
    activationUnwind: input.activationUnwind,
    mutations: input.mutations,
    eventLogger: input.eventLogger,
    errorLogger: input.errorLogger,
    emit: (eventName, data) => input.events.emit(eventName, data),
    emitRuntimeDiagnostic: (diagnostic) => input.events.emitRuntimeDiagnostic(diagnostic),
    now: input.now,
  });
  const pendingActivations = new PendingActivationDispatcher({
    projectRoot: input.projectRoot,
    cards: input.cards,
    activationUnwind: input.activationUnwind,
    lifecycle: input.lifecycle,
    dispatchGoalThroughScheduler: (goalId) => activationScheduler.dispatch(goalId),
    executorActivations,
  });
  const reviewerDispatcher = new RuntimeReviewerDispatcher({
    cards: input.cards,
    agentRuntime: input.agentRuntime,
    skillsEngine: () => input.getSkillsEngine(),
    eventLogger: input.eventLogger,
    errorLogger: input.errorLogger,
    stateMachine,
    goalContext: input.goalContext,
    activationUnwind: input.activationUnwind,
    runLedger: input.runLedger,
    emit: (eventName, data) => input.events.emit(eventName, data),
    emitRuntimeDiagnostic: (diagnostic) => input.events.emitRuntimeDiagnostic(diagnostic),
    now: input.now,
  });
  const plannerDispatcher = new RuntimePlannerDispatcher({
    projectRoot: input.projectRoot,
    cards: input.cards,
    agentRuntime: input.agentRuntime,
    skillsEngine: () => input.getSkillsEngine(),
    eventLogger: input.eventLogger,
    errorLogger: input.errorLogger,
    stateMachine,
    goalContext: input.goalContext,
    pendingActivations,
    reviewerDispatcher,
    mutations: input.mutations,
    runLedger: input.runLedger,
    sessionStamper: input.sessionStamper,
    lifecycle: input.lifecycle,
    emit: (eventName, data) => input.events.emit(eventName, data),
    emitRuntimeDiagnostic: (diagnostic) => input.events.emitRuntimeDiagnostic(diagnostic),
    plannerFailureHandler: new PlannerFailureHandler({
      projectRoot: input.projectRoot,
      cards: input.cards,
      eventLogger: input.eventLogger,
      errorLogger: input.errorLogger,
      stateMachine,
      mutations: input.mutations,
      emitRuntimeDiagnostic: (diagnostic) => input.events.emitRuntimeDiagnostic(diagnostic),
      publishRuntimeRun: (run) => input.events.publishRuntimeLedgerEvent('runtime_run', { run }),
      now: input.now,
    }),
    now: input.now,
  });
  cardDispatcher = new RuntimeCardDispatcher({
    plannerDispatcher,
    lifecycle: input.lifecycle,
  });
  return {
    activationScheduler,
    stateMachine,
    projectCommands,
    pauseResume,
    executorActivations,
    pendingActivations,
    reviewerDispatcher,
    plannerDispatcher,
    cardDispatcher,
  };
}
