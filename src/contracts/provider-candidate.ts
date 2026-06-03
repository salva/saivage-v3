/** A concrete provider/account/model triple that the router can attempt. */
export interface Candidate {
  provider: string;
  account: string | null;
  model: string;
}

/** Serialize a Candidate into a stable string key for health tracking. */
export function candidateKey(c: Candidate): string {
  return `${c.provider}/${c.account ?? '_'}/${c.model}`;
}

/** Parse a candidate key back into a Candidate. */
export function parseCandidateKey(key: string): Candidate {
  const parts = key.split('/');
  if (parts.length !== 3) {
    throw new Error(`Invalid candidate key: ${key}`);
  }
  return {
    provider: parts[0],
    account: parts[1] === '_' ? null : parts[1],
    model: parts[2],
  };
}
