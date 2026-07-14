export type InterventionReadiness = 'stopped' | 'paused' | 'not_ready';

export interface InterventionReadinessFacet {
  interventionReadiness(): InterventionReadiness;
  assertInterventionReady(): void;
}

export class RuntimeInterventionBinding implements InterventionReadinessFacet {
  #state: InterventionReadiness = 'not_ready';

  interventionReadiness(): InterventionReadiness { return this.#state; }
  markNotReady(): void { this.#state = 'not_ready'; }
  markStoppedReady(): void { this.#state = 'stopped'; }
  markPausedReady(): void { this.#state = 'paused'; }
  assertInterventionReady(): void {
    if (this.#state === 'not_ready') throw new Error('Analyst mutation requires an intervention-ready stopped or settled paused runtime.');
  }
}
