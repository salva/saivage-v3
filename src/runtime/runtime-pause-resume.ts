import type { EventLogger } from '../observability/index.js';
import { setProcessTerminalBuffering } from './process-runner.js';
import { buildPauseRuntimeStatePatch, buildResumeRuntimeStatePatch } from './runtime-core.js';
import { readRuntimeState, updateRuntimeState } from './state.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';

export class RuntimePauseResumeController {
  constructor(
    private readonly deps: {
      projectRoot: string;
      eventLogger: EventLogger;
      stateMachine: RuntimeStateMachine;
      goalContext: RuntimeGoalContextCoordinator;
      setPaused(paused: boolean): void;
      emit(eventName: string, data?: Record<string, unknown>): void;
      now(): string;
    },
  ) {}

  pause(): void {
    this.deps.setPaused(true);
    setProcessTerminalBuffering(this.deps.projectRoot, true);
    try {
      updateRuntimeState(this.deps.projectRoot, buildPauseRuntimeStatePatch(this.deps.now()));
    } catch {
      void 0;
    }
    this.deps.emit('paused');
    this.deps.eventLogger.appendEvent({ kind: 'paused' });
  }

  resume(): void {
    this.deps.setPaused(false);
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
      updateRuntimeState(this.deps.projectRoot, buildResumeRuntimeStatePatch(state));
    } catch {
      void 0;
    }
    this.deps.emit('resumed');
    this.deps.eventLogger.appendEvent({ kind: 'resumed' });
    void this.deps.stateMachine.requestImmediateTick();
  }
}
