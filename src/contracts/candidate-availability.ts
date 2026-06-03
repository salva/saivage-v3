/**
 * CandidateAvailability — on-disk availability substrate for LLM provider candidates.
 *
 * Replaces the in-memory `ProviderRegistry` health surface. Decisions about
 * cooldown / blocking come from the invocation recovery policy as
 * `AvailabilityDecision` values that this substrate persists.
 */

import { type Candidate, candidateKey } from './provider-candidate.js';

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

/** In-memory implementation suitable for tests and short-lived processes. */
export class MemoryCandidateAvailability implements CandidateAvailability {
  protected readonly entries = new Map<string, CandidateAvailabilityEntry>();

  isAvailable(candidate: Candidate): boolean {
    const entry = this.entries.get(candidateKey(candidate));
    if (!entry) return true;
    if (entry.state === 'HEALTHY') return true;
    return Date.now() >= entry.untilMs;
  }

  async markSucceeded(candidate: Candidate): Promise<void> {
    const key = candidateKey(candidate);
    const next: CandidateAvailabilityEntry = {
      candidate,
      state: 'HEALTHY',
      untilMs: 0,
      updatedAtMs: Date.now(),
    };
    this.entries.set(key, next);
    await this.persist(next);
  }

  async markFailed(candidate: Candidate, decision: AvailabilityDecision): Promise<void> {
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
    await this.persist(next);
  }

  getEntry(candidate: Candidate): CandidateAvailabilityEntry | undefined {
    return this.entries.get(candidateKey(candidate));
  }

  getAllEntries(): CandidateAvailabilityEntry[] {
    return Array.from(this.entries.values());
  }

  /** Hook for subclasses that want durable persistence. */
  protected async persist(_entry: CandidateAvailabilityEntry): Promise<void> {
    return;
  }
}
