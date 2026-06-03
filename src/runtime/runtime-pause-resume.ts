import type { EventLogger } from '../observability/index.js';
import { setProcessTerminalBuffering } from './process-runner.js';
import { buildPauseRuntimeStatePatch, buildResumeRuntimeStatePatch } from './runtime-core.js';
import { readRuntimeState } from './state.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import type { RuntimeStateMutationPort } from './mutations.js';
import type { RuntimeLifecycleState } from './runtime-lifecycle-state.js';

export class RuntimePauseResumeController {
  constructor(
    private readonly deps: {
      projectRoot: string;
      eventLogger: EventLogger;
      stateMachine: RuntimeStateMachine;
      goalContext: RuntimeGoalContextCoordinator;
      mutations: RuntimeStateMutationPort;
      lifecycle: RuntimeLifecycleState;
      emit(eventName: string, data?: Record<string, unknown>): void;
      now(): string;
    },
  ) {}

  pause(): void {
    this.deps.lifecycle.setPaused(true);
    setProcessTerminalBuffering(this.deps.projectRoot, true);
    try {
      this.deps.mutations.apply({ kind: 'patchRuntimeState', patch: buildPauseRuntimeStatePatch(this.deps.now()) });
    } catch {
      void 0;
    }
    this.deps.emit('paused');
    this.deps.eventLogger.appendEvent({ kind: 'paused' });
  }

  resume(): void {
    this.deps.lifecycle.setPaused(false);
    setProcessTerminalBuffering(this.deps.projectRoot, false);
    try {
      const state = readRuntimeState(this.deps.projectRoot);
      const plannerSessionId =
        state?.active_card_run?.planner_session_id ?? state?.current_agent_session_id;
      if (plannerSessionId && state?.active_card_run?.card_id) {
        this.deps.goalContext.appendPlannerResumeContext(
          state.active_card_run.card_id,
          plannerSessionId,
          this.deps.goalContext.inferResumeReason(state.active_card_run.card_id),
        );
        this.deps.goalContext.injectQueuedPlannerNotes(plannerSessionId);
      }
      this.deps.mutations.apply({ kind: 'patchRuntimeState', patch: buildResumeRuntimeStatePatch(state) });
    } catch {
      void 0;
    }
    this.deps.emit('resumed');
    this.deps.eventLogger.appendEvent({ kind: 'resumed' });
    void this.deps.stateMachine.requestImmediateTick();
  }
}
