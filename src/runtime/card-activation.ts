import type { RuntimeState } from '../schemas/index.js';
import { activationStateFromActiveRun, reduceActivation, type ActivationDecision, type ActivationEvent, type ActivationState } from './activation-reducer.js';

export class CardActivation {
  private _state: ActivationState;

  constructor(initialState: ActivationState) {
    this._state = initialState;
  }

  get state(): ActivationState {
    return this._state;
  }

  dispatch(event: ActivationEvent): ActivationDecision {
    const decision = reduceActivation(this._state, event);
    this._state = decision.state;
    return decision;
  }
}

export function activationFromRuntimeState(state: RuntimeState | null): CardActivation | null {
  const activationState = activationStateFromActiveRun(state?.active_card_run ?? null);
  return activationState ? new CardActivation(activationState) : null;
}
