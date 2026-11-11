/** Pure fatal identity, also usable by browser-safe observation contracts. */
export class PublicationOutcomeUnknownError extends Error {
  constructor(cause?: unknown) {
    super('Saivage durable publication outcome is unknown.', { cause });
    this.name = 'PublicationOutcomeUnknownError';
  }
}
