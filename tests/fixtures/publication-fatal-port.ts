import { closeSync } from 'node:fs';
import { createApplicationFatalPort, PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

if (process.argv[2] === 'closed-stderr') closeSync(2);
createApplicationFatalPort().publicationOutcomeUnknown(new PublicationOutcomeUnknownError());
