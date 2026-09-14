export class CardInterruptedError extends Error {
  constructor(message = 'Card activation interrupted after urgent notification.') {
    super(message);
    this.name = 'CardInterruptedError';
  }
}

export function isCardInterruptedError(value: unknown): value is CardInterruptedError {
  return value instanceof CardInterruptedError;
}
