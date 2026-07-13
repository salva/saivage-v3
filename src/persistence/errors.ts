export class PersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class PersistenceReadError extends PersistenceError {
  constructor(readonly path: string, message: string, options?: ErrorOptions) {
    super(`Failed to read ${path}: ${message}`, options);
  }
}

export class PersistenceWriteError extends PersistenceError {
  constructor(readonly path: string, message: string, options?: ErrorOptions) {
    super(`Failed to write ${path}: ${message}`, options);
  }
}

export class IndeterminatePublicationError extends PersistenceError {
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`Publication of ${path} may have completed, but its durability could not be confirmed`, options);
  }
}

export class PersistenceValidationError extends PersistenceReadError {
  constructor(path: string, message: string, options?: ErrorOptions) {
    super(path, `validation failed: ${message}`, options);
  }
}

export class PersistenceVersionMismatch extends PersistenceReadError {
  constructor(path: string, expectedVersion: number, actualVersion: unknown) {
    super(
      path,
      `schema version mismatch: expected version ${expectedVersion}, found ${String(actualVersion)}. Reset .saivage runtime state and restart.`,
    );
  }
}
