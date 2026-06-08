import { setProcessTerminalBuffering } from './process-runner.js';
import { deriveCurrentAgentSessionId } from './current-run.js';
import { readRuntimeState } from './state.js';
import { pauseRuntimeCommand, resumeRuntimeCommand, type PauseResumeEffects } from './runtime-control-commands.js';
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
  const effects: PauseResumeEffects = {
    readState: () => readRuntimeState(deps.projectRoot),
    now: deps.now,
    setLifecyclePaused: (paused) => { deps.lifecycle.paused = paused; },
    setProcessBuffering: (enabled) => {
      try { setProcessTerminalBuffering(deps.projectRoot, enabled); } catch { void 0; }
    },
    beforeResumeStatePatch: (state) => {
      try {
        const plannerSessionId = state?.active_card_run?.phase === 'planner' ? deriveCurrentAgentSessionId(state) : null;
        if (plannerSessionId && state?.active_card_run?.card_id) {
          deps.goalContext.appendPlannerResumeContext(
            state.active_card_run.card_id,
            plannerSessionId,
            'service_restart',
          );
        }
      } catch { void 0; }
    },
    applyStatePatch: (patch) => {
      try { deps.mutations.apply({ kind: 'patchRuntimeState', patch }); } catch { void 0; }
    },
    emitRuntimeEvent: (kind) => deps.emit(kind),
    logEvent: (kind) => deps.eventLogger.appendEvent({ kind }),
    requestImmediateTick: () => { void deps.stateMachine.requestImmediateTick(); },
  };
  return {
    pause(): void {
      pauseRuntimeCommand(deps.projectRoot, effects);
    },

    resume(): void {
      resumeRuntimeCommand(deps.projectRoot, effects);
    },
  };
}
