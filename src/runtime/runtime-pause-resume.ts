import { setProcessTerminalBuffering } from './process-runner.js';
import { buildPauseRuntimeStatePatch, buildResumeRuntimeStatePatch } from './runtime-core.js';
import { readRuntimeState } from './state.js';
import type { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import type { RuntimeServices } from './runtime-services.js';

interface RuntimePauseResumeControllerDeps extends Pick<RuntimeServices,
  | 'projectRoot'
  | 'eventLogger'
  | 'stateMachine'
  | 'mutations'
  | 'lifecycle'
  | 'emit'
  | 'now'
> {
  goalContext: RuntimeGoalContextCoordinator;
}

export interface RuntimePauseResumeController {
  pause(): void;
  resume(): void;
}

export function createRuntimePauseResumeController(deps: RuntimePauseResumeControllerDeps): RuntimePauseResumeController {
  return {
    /** Applies the full pause field group and enables process-output buffering. */
    pause(): void {
    deps.lifecycle.paused = true;
    setProcessTerminalBuffering(deps.projectRoot, true);
    try {
      deps.mutations.apply({ kind: 'patchRuntimeState', patch: buildPauseRuntimeStatePatch(deps.now()) });
    } catch {
      void 0;
    }
    deps.emit('paused');
    deps.eventLogger.appendEvent({ kind: 'paused' });
    },

    /** Applies the full resume field group after injecting planner resume context. */
    resume(): void {
    deps.lifecycle.paused = false;
    setProcessTerminalBuffering(deps.projectRoot, false);
    try {
      const state = readRuntimeState(deps.projectRoot);
      const plannerSessionId =
        state?.active_card_run?.planner_session_id ?? state?.current_agent_session_id;
      if (plannerSessionId && state?.active_card_run?.card_id) {
        deps.goalContext.appendPlannerResumeContext(
          state.active_card_run.card_id,
          plannerSessionId,
          deps.goalContext.inferResumeReason(state.active_card_run.card_id),
        );
        deps.goalContext.injectQueuedPlannerNotes(plannerSessionId);
      }
      deps.mutations.apply({ kind: 'patchRuntimeState', patch: buildResumeRuntimeStatePatch(state) });
    } catch {
      void 0;
    }
    deps.emit('resumed');
    deps.eventLogger.appendEvent({ kind: 'resumed' });
    void deps.stateMachine.requestImmediateTick();
    },
  };
}
