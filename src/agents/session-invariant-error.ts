export class SessionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionInvariantError';
  }
}
