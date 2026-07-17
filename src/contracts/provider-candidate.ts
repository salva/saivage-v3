/** A concrete provider/account/model triple that the router can attempt. */
export interface Candidate {
  provider: string;
  account: string | null;
  model: string;
}

export function candidatesEqual(left: Candidate, right: Candidate): boolean {
  return left.provider === right.provider && left.account === right.account && left.model === right.model;
}
