export interface PersistenceFailureDiagnostic {
  readonly target: string;
  readonly operation: string;
  readonly message: string;
  readonly reported_at: string;
}

export type ApplicationPersistenceHealthSnapshot =
  | { readonly state: 'healthy' }
  | { readonly state: 'mutation_unhealthy'; readonly diagnostic: PersistenceFailureDiagnostic };

export class PersistenceMutationUnhealthyError extends Error {
  constructor(readonly diagnostic: PersistenceFailureDiagnostic) {
    super(`Application persistence is mutation-unhealthy after ${diagnostic.operation} on ${diagnostic.target}: ${diagnostic.message}`);
    this.name = 'PersistenceMutationUnhealthyError';
  }
}

export class ApplicationPersistenceHealth {
  #diagnostic: PersistenceFailureDiagnostic | null = null;

  assertMutationHealthy(): void {
    if (this.#diagnostic !== null) throw new PersistenceMutationUnhealthyError(this.#diagnostic);
  }

  reportUncertainFailure(input: { target: string; operation: string; error: unknown }): never {
    if (this.#diagnostic === null) {
      this.#diagnostic = Object.freeze({
        target: input.target,
        operation: input.operation,
        message: input.error instanceof Error ? input.error.message : String(input.error),
        reported_at: new Date().toISOString(),
      });
    }
    throw new PersistenceMutationUnhealthyError(this.#diagnostic);
  }

  snapshot(): ApplicationPersistenceHealthSnapshot {
    return this.#diagnostic === null
      ? Object.freeze({ state: 'healthy' })
      : Object.freeze({ state: 'mutation_unhealthy', diagnostic: this.#diagnostic });
  }
}
