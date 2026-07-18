export class CardServiceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardServiceInvariantError';
  }
}
