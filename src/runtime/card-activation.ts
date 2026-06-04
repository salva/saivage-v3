import type { RuntimeState } from '../schemas/index.js';
import { activeRunFromActivationState, activationStateFromActiveRun, reduceActivation, type ActivationDecision, type ActivationEvent, type ActivationState } from './activation-reducer.js';

export type ActiveCardRun = NonNullable<RuntimeState['active_card_run']>;

/**
 * @internal
 * @stage activation-state-machine
 *
 * Snapshot helper around activation-reducer.ts. This is not the authoritative
 * runtime transition engine; hot-path card transitions still go through
 * RuntimeStateMachine and activation completion still goes through the runtime
 * mutation port.
 */
export class CardActivation {
  private _state: ActivationState;

  constructor(initialState: ActivationState) {
    this._state = initialState;
  }

  static fromActiveRun(activeRun: RuntimeState['active_card_run']): CardActivation | null {
    const activationState = activationStateFromActiveRun(activeRun);
    return activationState ? new CardActivation(activationState) : null;
  }

  get state(): ActivationState {
    return this._state;
  }

  dispatch(event: ActivationEvent): ActivationDecision {
    const decision = reduceActivation(this._state, event);
    this._state = decision.state;
    return decision;
  }

  toActiveRun(nowIso: string): RuntimeState['active_card_run'] {
    return activeRunFromActivationState(this._state, nowIso);
  }
}

export function activationFromRuntimeState(state: RuntimeState | null): CardActivation | null {
  return CardActivation.fromActiveRun(state?.active_card_run ?? null);
}
