import { writeSync } from 'node:fs';

export class PublicationOutcomeUnknownError extends Error {
  constructor() {
    super('Saivage durable publication outcome is unknown.');
    this.name = 'PublicationOutcomeUnknownError';
  }
}

export interface ApplicationFatalPort {
  publicationOutcomeUnknown(error: PublicationOutcomeUnknownError): never;
}

export function throwIfPublicationOutcomeUnknown(error: unknown): void {
  if (error instanceof PublicationOutcomeUnknownError) throw error;
}

const PUBLICATION_FATAL_BYTES = Buffer.from(
  'Fatal: PublicationOutcomeUnknownError; Saivage is halting because durable publication outcome is unknown.\n',
  'utf8',
);

export function createApplicationFatalPort(): ApplicationFatalPort {
  return Object.freeze({
    publicationOutcomeUnknown(_error: PublicationOutcomeUnknownError): never {
      try {
        let offset = 0;
        while (offset < PUBLICATION_FATAL_BYTES.byteLength) {
          const written = writeSync(2, PUBLICATION_FATAL_BYTES, offset, PUBLICATION_FATAL_BYTES.byteLength - offset);
          if (written === 0) break;
          offset += written;
        }
      } finally {
        process.exit(1);
      }
    },
  });
}
