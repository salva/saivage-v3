import { closeSync } from 'node:fs';
import { createApplicationFatalPort, PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

if (process.argv[2] === 'closed-stderr') closeSync(2);
const cause = process.argv[2] === 'with-cause'
  ? Object.assign(new Error('ENOSPC: no space left on device, write /work/.saivage/state.jsonl'), { code: 'ENOSPC' })
  : undefined;
createApplicationFatalPort().publicationOutcomeUnknown(new PublicationOutcomeUnknownError(cause));
