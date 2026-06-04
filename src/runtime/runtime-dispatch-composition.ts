import type { CardStore } from '../cards/store-api.js';
import type { AgentExecutionPort } from '../contracts/index.js';
import type { SessionStamper } from '../contracts/session-stamper.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import { ExecutorActivationDispatcher } from './executor-activation-dispatcher.js';
import { PendingActivationDispatcher } from './pending-activation-dispatcher.js';
import { PlannerFailureHandler } from './phases/planner-failure-handler.js';
import type { RuntimeDiagnostics } from './runtime-diagnostics.js';
import type { RuntimeEventPublisher } from './runtime-event-publisher.js';
import type { RuntimeConfig, RuntimeSkillsPort } from './runtime-config.js';
import { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import type { LifecycleFlags } from './runtime-lifecycle-state.js';
import { createRuntimePauseResumeController, type RuntimePauseResumeController } from './runtime-pause-resume.js';
import { RuntimePlannerDispatcher } from './runtime-planner-dispatcher.js';
import { RuntimeProjectCommandRunner } from './runtime-project-commands.js';
import { RuntimeReviewerDispatcher } from './runtime-reviewer-dispatcher.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import { createRuntimeStateMachine, type RuntimeStateMachine } from './state-machine.js';
import type { RuntimeStateMutationPort } from './mutations.js';
import type { RuntimeServices } from './runtime-services.js';

export interface RuntimeDispatchCollaborators {
  stateMachine: RuntimeStateMachine;
  projectCommands: RuntimeProjectCommandRunner;
  pauseResume: RuntimePauseResumeController;
  executorActivations: ExecutorActivationDispatcher;
  pendingActivations: PendingActivationDispatcher;
  reviewerDispatcher: RuntimeReviewerDispatcher;
  plannerDispatcher: RuntimePlannerDispatcher;
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
  lifecycle: LifecycleFlags;
  sessionStamper: SessionStamper;
  activationUnwind: ActivationUnwindRunner;
  goalContext: RuntimeGoalContextCoordinator;
  runLedger: RuntimeRunLedger;
  now(): string;
}): RuntimeDispatchCollaborators {
  let plannerDispatcher!: RuntimePlannerDispatcher;
  const stateMachine = createRuntimeStateMachine({
    projectRoot: input.projectRoot,
    cards: input.cards,
    errorLogger: input.errorLogger,
    mutations: input.mutations,
    dispatchGoalThroughScheduler: (cardId) => {
      void plannerDispatcher.dispatchGoal(cardId);
    },
  });
  const services: RuntimeServices = {
    projectRoot: input.projectRoot,
    cards: input.cards,
    eventLogger: input.eventLogger,
    errorLogger: input.errorLogger,
    stateMachine,
    mutations: input.mutations,
    lifecycle: input.lifecycle,
    emit: (eventName, data) => input.events.emit(eventName, data),
    emitRuntimeDiagnostic: (diagnostic) => input.events.emitRuntimeDiagnostic(diagnostic),
    now: input.now,
  };
  const projectCommands = new RuntimeProjectCommandRunner({
    projectRoot: services.projectRoot,
    cards: services.cards,
    agentRuntime: input.agentRuntime,
    eventLogger: services.eventLogger,
    sessionStamper: input.sessionStamper,
    stateMachine: services.stateMachine,
    mutations: services.mutations,
    lifecycle: services.lifecycle,
    now: services.now,
    publishRuntimeCommand: (command) => input.events.publishRuntimeLedgerEvent('runtime_command', { command }),
    publishRuntimeRun: (run) => input.events.publishRuntimeLedgerEvent('runtime_run', { run }),
    publishActionableError: (error) =>
      input.events.publishRuntimeLedgerEvent('runtime_actionable_error', { actionable_error: error }),
    trackBackgroundDispatch: (dispatch) => input.diagnostics.trackBackgroundDispatch(dispatch),
    dispatchGoalThroughScheduler: (goalId) => plannerDispatcher.dispatchGoal(goalId),
  });
  const pauseResume = createRuntimePauseResumeController({
    projectRoot: services.projectRoot,
    eventLogger: services.eventLogger,
    stateMachine: services.stateMachine,
    goalContext: input.goalContext,
    mutations: services.mutations,
    lifecycle: services.lifecycle,
    emit: services.emit,
    now: services.now,
  });
  const executorActivations = new ExecutorActivationDispatcher({
    projectRoot: services.projectRoot,
    cards: services.cards,
    agentRuntime: input.agentRuntime,
    skillsEngine: input.getSkillsEngine(),
    stateMachine: services.stateMachine,
    activationUnwind: input.activationUnwind,
    mutations: services.mutations,
    eventLogger: services.eventLogger,
    errorLogger: services.errorLogger,
    emit: services.emit,
    emitRuntimeDiagnostic: services.emitRuntimeDiagnostic,
    now: services.now,
  });
  const pendingActivations = new PendingActivationDispatcher({
    projectRoot: services.projectRoot,
    cards: services.cards,
    activationUnwind: input.activationUnwind,
    lifecycle: services.lifecycle,
    dispatchGoalThroughScheduler: (goalId) => plannerDispatcher.dispatchGoal(goalId),
    executorActivations,
  });
  const reviewerDispatcher = new RuntimeReviewerDispatcher({
    cards: services.cards,
    agentRuntime: input.agentRuntime,
    skillsEngine: () => input.getSkillsEngine(),
    eventLogger: services.eventLogger,
    errorLogger: services.errorLogger,
    stateMachine: services.stateMachine,
    goalContext: input.goalContext,
    activationUnwind: input.activationUnwind,
    runLedger: input.runLedger,
    emit: services.emit,
    emitRuntimeDiagnostic: services.emitRuntimeDiagnostic,
    now: services.now,
  });
  plannerDispatcher = new RuntimePlannerDispatcher({
    projectRoot: services.projectRoot,
    cards: services.cards,
    agentRuntime: input.agentRuntime,
    skillsEngine: () => input.getSkillsEngine(),
    eventLogger: services.eventLogger,
    errorLogger: services.errorLogger,
    stateMachine: services.stateMachine,
    goalContext: input.goalContext,
    pendingActivations,
    reviewerDispatcher,
    mutations: services.mutations,
    runLedger: input.runLedger,
    sessionStamper: input.sessionStamper,
    goalDispatcher: input.config.goalDispatcher,
    lifecycle: services.lifecycle,
    emit: services.emit,
    emitRuntimeDiagnostic: services.emitRuntimeDiagnostic,
    plannerFailureHandler: new PlannerFailureHandler({
      projectRoot: services.projectRoot,
      cards: services.cards,
      eventLogger: services.eventLogger,
      errorLogger: services.errorLogger,
      stateMachine: services.stateMachine,
      mutations: services.mutations,
      emitRuntimeDiagnostic: services.emitRuntimeDiagnostic,
      publishRuntimeRun: (run) => input.events.publishRuntimeLedgerEvent('runtime_run', { run }),
      now: services.now,
    }),
    now: services.now,
  });
  return {
    stateMachine,
    projectCommands,
    pauseResume,
    executorActivations,
    pendingActivations,
    reviewerDispatcher,
    plannerDispatcher,
  };
}
