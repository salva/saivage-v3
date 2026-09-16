import { writeSync } from 'node:fs';

export class PublicationOutcomeUnknownError extends Error {
  constructor(cause?: unknown) {
    super('Saivage durable publication outcome is unknown.', { cause });
    this.name = 'PublicationOutcomeUnknownError';
  }
}

export interface ApplicationFatalPort {
  publicationOutcomeUnknown(error: PublicationOutcomeUnknownError): never;
}

export function throwIfPublicationOutcomeUnknown(error: unknown): void {
  if (error instanceof PublicationOutcomeUnknownError) throw error;
}

const PUBLICATION_FATAL_PREFIX = 'Fatal: PublicationOutcomeUnknownError; Saivage is halting because durable publication outcome is unknown.';

export function createApplicationFatalPort(): ApplicationFatalPort {
  return Object.freeze({
    publicationOutcomeUnknown(error: PublicationOutcomeUnknownError): never {
      try {
        const cause = error.cause;
        const causeSuffix = cause === undefined ? '' : ` Cause: ${cause instanceof Error ? cause.message : String(cause)}`;
        const bytes = Buffer.from(`${PUBLICATION_FATAL_PREFIX}${causeSuffix}\n`, 'utf8');
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = writeSync(2, bytes, offset, bytes.byteLength - offset);
          if (written === 0) break;
          offset += written;
        }
      } finally {
        process.exit(1);
      }
    },
  });
}
