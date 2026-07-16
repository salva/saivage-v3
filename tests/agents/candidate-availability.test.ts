import { describe, expect, it } from '@jest/globals';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';

const candidate: Candidate = { provider: 'p', account: 'a', model: 'm' };

describe('MemoryCandidateAvailability', () => {
  it('applies live transitions and preserves the longest active block', () => {
    const availability = new MemoryCandidateAvailability();
    expect(availability.isAvailable(candidate)).toBe(true);
    const strongest = Date.now() + 120_000;
    availability.markFailed(candidate, { state: 'BLOCKED_UNTIL', untilMs: strongest, reason: 'rate_limit' });
    availability.markFailed(candidate, { state: 'COOLING', untilMs: Date.now() + 5_000, reason: 'transient' });
    expect(availability.getEntry(candidate)?.untilMs).toBe(strongest);
    availability.markSucceeded(candidate);
    expect(availability.isAvailable(candidate)).toBe(true);
  });

  it('starts empty for every new process-local owner', () => {
    const first = new MemoryCandidateAvailability();
    first.markFailed(candidate, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 60_000, reason: 'rate_limit' });
    const restarted = new MemoryCandidateAvailability();
    expect(restarted.getAllEntries()).toEqual([]);
    expect(restarted.isAvailable(candidate)).toBe(true);
  });
});
