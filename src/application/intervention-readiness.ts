export interface InterventionReadinessFacet {
  assertInterventionReady(): void;
}

export class AnalystInterventionNotReadyError extends Error {
  constructor() {
    super('Analyst mutation requires an intervention-ready stopped or settled paused runtime.');
    this.name = 'AnalystInterventionNotReadyError';
  }
}
