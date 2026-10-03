import { sha256Hex } from '../schemas/index.js';
import type { Candidate } from '../contracts/index.js';

export function responsesProducerAccountId(
  candidate: Pick<Candidate, 'provider' | 'account'>,
): string {
  return sha256Hex(JSON.stringify(['openai-responses-account', candidate.provider, candidate.account]));
}
