/**
 * CandidateAvailability — process-local, in-memory availability contract for
 * LLM provider candidates.
 *
 * Invocation recovery supplies cooldown and blocking decisions. Those
 * decisions remain process-local and reset on restart.
 */

import type { Candidate } from './provider-candidate.js';

type CandidateState = 'HEALTHY' | 'BLOCKED_UNTIL' | 'COOLING';

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
  markSucceeded(candidate: Candidate): void;
  markFailed(candidate: Candidate, decision: AvailabilityDecision): void;
  getEntry(candidate: Candidate): CandidateAvailabilityEntry | undefined;
  getAllEntries(): CandidateAvailabilityEntry[];
}
