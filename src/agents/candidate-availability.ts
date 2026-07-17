/**
 * Process-local candidate availability for one application lifetime.
 */

import { candidatesEqual, type Candidate } from '../contracts/provider-candidate.js';
import type { AvailabilityDecision, CandidateAvailability, CandidateAvailabilityEntry } from '../contracts/candidate-availability.js';
export type { AvailabilityDecision, CandidateAvailability, CandidateAvailabilityEntry, CandidateState } from '../contracts/candidate-availability.js';

/** Availability intentionally resets whenever the process restarts. */
export class MemoryCandidateAvailability implements CandidateAvailability {
  protected readonly entries: CandidateAvailabilityEntry[] = [];

  private indexOf(candidate: Candidate): number {
    return this.entries.findIndex((entry) => candidatesEqual(entry.candidate, candidate));
  }

  isAvailable(candidate: Candidate): boolean {
    const entry = this.getEntry(candidate);
    if (!entry) return true;
    if (entry.state === 'HEALTHY') return true;
    return Date.now() >= entry.untilMs;
  }

  markSucceeded(candidate: Candidate): void {
    const next: CandidateAvailabilityEntry = {
      candidate,
      state: 'HEALTHY',
      untilMs: 0,
      updatedAtMs: Date.now(),
    };
    const index = this.indexOf(candidate);
    if (index < 0) this.entries.push(next); else this.entries[index] = next;
  }

  markFailed(candidate: Candidate, decision: AvailabilityDecision): void {
    const now = Date.now();
    const prev = this.getEntry(candidate);
    // Monotonic-untilMs invariant: a new failure may not shorten a longer
    // existing block. Preserves provider-issued Retry-After/resets_at horizons.
    let untilMs = decision.untilMs;
    if (prev && prev.state !== 'HEALTHY' && prev.untilMs > untilMs) {
      untilMs = prev.untilMs;
    }
    const next: CandidateAvailabilityEntry = {
      candidate,
      state: decision.state,
      untilMs,
      reason: decision.reason,
      updatedAtMs: now,
    };
    const index = this.indexOf(candidate);
    if (index < 0) this.entries.push(next); else this.entries[index] = next;
  }

  getEntry(candidate: Candidate): CandidateAvailabilityEntry | undefined {
    return this.entries.find((entry) => candidatesEqual(entry.candidate, candidate));
  }

  getAllEntries(): CandidateAvailabilityEntry[] {
    return [...this.entries];
  }
}
