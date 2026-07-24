import type { ApplicationFatalPort, PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

export const testApplicationFatalPort: ApplicationFatalPort = Object.freeze({
  publicationOutcomeUnknown(_error: PublicationOutcomeUnknownError): never { throw testApplicationFatalDelivery; },
});

export const testApplicationFatalDelivery = new Error('test application fatal delivery');
