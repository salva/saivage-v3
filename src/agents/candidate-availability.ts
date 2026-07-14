/**
 * CandidateAvailability — on-disk availability substrate for LLM provider candidates.
 *
 * Replaces the in-memory `ProviderRegistry` health surface. Decisions about
 * cooldown / blocking come from the invocation recovery policy as
 * `AvailabilityDecision` values that this substrate persists.
 */

import { candidateKey, type Candidate } from '../contracts/provider-candidate.js';
import type { AvailabilityDecision, CandidateAvailability, CandidateAvailabilityEntry } from '../contracts/candidate-availability.js';
export type { AvailabilityDecision, CandidateAvailability, CandidateAvailabilityEntry, CandidateState } from '../contracts/candidate-availability.js';

/** In-memory implementation suitable for tests and short-lived processes. */
export class MemoryCandidateAvailability implements CandidateAvailability {
  protected readonly entries = new Map<string, CandidateAvailabilityEntry>();

  isAvailable(candidate: Candidate): boolean {
    const entry = this.entries.get(candidateKey(candidate));
    if (!entry) return true;
    if (entry.state === 'HEALTHY') return true;
    return Date.now() >= entry.untilMs;
  }

  markSucceeded(candidate: Candidate): void {
    const key = candidateKey(candidate);
    const next: CandidateAvailabilityEntry = {
      candidate,
      state: 'HEALTHY',
      untilMs: 0,
      updatedAtMs: Date.now(),
    };
    this.entries.set(key, next);
  }

  markFailed(candidate: Candidate, decision: AvailabilityDecision): void {
    const key = candidateKey(candidate);
    const now = Date.now();
    const prev = this.entries.get(key);
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
    this.entries.set(key, next);
  }

  getEntry(candidate: Candidate): CandidateAvailabilityEntry | undefined {
    return this.entries.get(candidateKey(candidate));
  }

  getAllEntries(): CandidateAvailabilityEntry[] {
    return Array.from(this.entries.values());
  }
}
