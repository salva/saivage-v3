/**
 * CandidateAvailability — on-disk availability substrate for LLM provider candidates.
 *
 * Replaces the in-memory `ProviderRegistry` health surface. Decisions about
 * cooldown / blocking come from the invocation recovery policy as
 * `AvailabilityDecision` values that this substrate persists.
 */

import type { Candidate } from './provider-candidate.js';

export type CandidateState = 'HEALTHY' | 'BLOCKED_UNTIL' | 'COOLING';

export interface CandidateAvailabilityEntry {
  candidate: Candidate;
  state: CandidateState;
  /** Wall-clock ms when BLOCKED_UNTIL or COOLING expires (0 for HEALTHY). */
  untilMs: number;
  reason?: string;
  updatedAtMs: number;
}

export interface AvailabilityDecision {
  state: Exclude<CandidateState, 'HEALTHY'>;
  untilMs: number;
  reason?: string;
}

export interface CandidateAvailability {
  isAvailable(candidate: Candidate): boolean;
  markSucceeded(candidate: Candidate): Promise<void>;
  markFailed(candidate: Candidate, decision: AvailabilityDecision): Promise<void>;
  getEntry(candidate: Candidate): CandidateAvailabilityEntry | undefined;
  getAllEntries(): CandidateAvailabilityEntry[];
}
