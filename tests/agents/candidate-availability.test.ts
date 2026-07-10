import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import {
  CandidateAvailabilityLockedError,
  FsCandidateAvailability,
} from '../../src/agents/candidate-availability-store.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';

const c: Candidate = { provider: 'p', account: 'a', model: 'm' };

describe('MemoryCandidateAvailability', () => {
  it('reports availability true by default', () => {
    const a = new MemoryCandidateAvailability();
    expect(a.isAvailable(c)).toBe(true);
    expect(a.getEntry(c)).toBeUndefined();
  });

  it('is unavailable while untilMs is in the future and recovers once past', async () => {
    const a = new MemoryCandidateAvailability();
    const until = Date.now() + 25;
    await a.markFailed(c, { state: 'BLOCKED_UNTIL', untilMs: until, reason: 'rate_limit' });
    expect(a.isAvailable(c)).toBe(false);
    await new Promise((r) => setTimeout(r, 35));
    expect(a.isAvailable(c)).toBe(true);
  });

  it('treats past untilMs as immediately available', async () => {
    const a = new MemoryCandidateAvailability();
    await a.markFailed(c, { state: 'BLOCKED_UNTIL', untilMs: Date.now() - 5_000, reason: 'rate_limit' });
    expect(a.isAvailable(c)).toBe(true);
  });

  it('markSucceeded clears COOLING state', async () => {
    const a = new MemoryCandidateAvailability();
    await a.markFailed(c, { state: 'COOLING', untilMs: Date.now() + 60_000, reason: 'server_transient' });
    expect(a.isAvailable(c)).toBe(false);
    await a.markSucceeded(c);
    expect(a.isAvailable(c)).toBe(true);
  });

  it('preserves a higher existing untilMs against a weaker markFailed (monotonic invariant)', async () => {
    const a = new MemoryCandidateAvailability();
    const strong = Date.now() + 120_000;
    await a.markFailed(c, { state: 'BLOCKED_UNTIL', untilMs: strong, reason: 'rate_limit' });
    await a.markFailed(c, { state: 'COOLING', untilMs: Date.now() + 5_000, reason: 'server_transient' });
    const entry = a.getEntry(c);
    expect(entry?.untilMs).toBe(strong);
  });
});

describe('FsCandidateAvailability', () => {
  let root: string;
  let store: FsCandidateAvailability | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-availability-'));
    store = null;
  });

  afterEach(() => {
    try { store?.dispose(); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('persists entries to JSONL and replays them on a fresh instance', async () => {
    store = new FsCandidateAvailability(root);
    const until = Date.now() + 60_000;
    await store.markFailed(c, { state: 'BLOCKED_UNTIL', untilMs: until, reason: 'rate_limit' });
    store.dispose();
    store = new FsCandidateAvailability(root);
    expect(store.isAvailable(c)).toBe(false);
    expect(store.getEntry(c)?.untilMs).toBe(until);
    expect(existsSync(join(root, '.saivage', 'state', 'provider-availability.jsonl'))).toBe(true);
  });

  it('compacts the JSONL once it exceeds compactBytes', async () => {
    store = new FsCandidateAvailability(root, { compactBytes: 200 });
    const file = join(root, '.saivage', 'state', 'provider-availability.jsonl');
    for (let i = 0; i < 50; i += 1) {
      await store.markFailed({ provider: 'p', account: 'a', model: 'm' }, { state: 'COOLING', untilMs: Date.now() + 1_000 + i, reason: `r${i}` });
    }
    const after = statSync(file).size;
    expect(after).toBeLessThanOrEqual(400);
  });

  it('throws CandidateAvailabilityLockedError on concurrent open and releases on dispose', () => {
    store = new FsCandidateAvailability(root);
    expect(() => new FsCandidateAvailability(root)).toThrow(CandidateAvailabilityLockedError);
    store.dispose();
    store = null;
    const reopened = new FsCandidateAvailability(root);
    expect(reopened.isAvailable(c)).toBe(true);
    reopened.dispose();
  });
});
