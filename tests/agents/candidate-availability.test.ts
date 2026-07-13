import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { CandidateAvailabilityStore } from '../../src/agents/candidate-availability-store.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';
import { RootCurrentness } from '../../src/application/mutation-authority.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';

const candidate: Candidate = { provider: 'p', account: 'a', model: 'm' };
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'saivage-availability-'));
  roots.push(value);
  return value;
}

function setup(projectRoot = root(), compactBytes = 262144) {
  const mutation = createMutationLane();
  const store = new CandidateAvailabilityStore(projectRoot, mutation.lane, compactBytes);
  store.restabilize(mutation.authority);
  return { projectRoot, store, authority: mutation.authority };
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.length = 0;
});

describe('MemoryCandidateAvailability', () => {
  it('applies availability transitions and preserves the longest active block', () => {
    const authority = createMutationLane().authority;
    const store = new MemoryCandidateAvailability();
    expect(store.isAvailable(candidate)).toBe(true);
    const strongest = Date.now() + 120_000;
    store.markFailed(authority, candidate, { state: 'BLOCKED_UNTIL', untilMs: strongest, reason: 'rate_limit' });
    store.markFailed(authority, candidate, { state: 'COOLING', untilMs: Date.now() + 5_000, reason: 'transient' });
    expect(store.getEntry(candidate)?.untilMs).toBe(strongest);
    store.markSucceeded(authority, candidate);
    expect(store.isAvailable(candidate)).toBe(true);
  });
});

describe('CandidateAvailabilityStore', () => {
  it('persists complete fsynced rows and strictly replays them in a fresh owner', () => {
    const projectRoot = root();
    const first = setup(projectRoot);
    const untilMs = Date.now() + 60_000;
    first.store.markFailed(first.authority, candidate, { state: 'BLOCKED_UNTIL', untilMs, reason: 'rate_limit' });

    const second = setup(projectRoot);
    expect(second.store.getEntry(candidate)).toMatchObject({ untilMs, state: 'BLOCKED_UNTIL', reason: 'rate_limit' });
    expect(readFileSync(second.store.jsonlPath, 'utf8').endsWith('\n')).toBe(true);
  });

  it('discards only an incomplete final tail during startup restabilization', () => {
    const projectRoot = root();
    const first = setup(projectRoot);
    first.store.markSucceeded(first.authority, candidate);
    writeFileSync(first.store.jsonlPath, `${readFileSync(first.store.jsonlPath, 'utf8')}{"candidate":`);

    const second = setup(projectRoot);
    expect(second.store.getEntry(candidate)?.state).toBe('HEALTHY');
    expect(readFileSync(second.store.jsonlPath, 'utf8').endsWith('\n')).toBe(true);
  });

  it('fails startup on a malformed complete row', () => {
    const projectRoot = root();
    const path = join(projectRoot, '.saivage', 'state', 'provider-availability.jsonl');
    mkdirSync(join(projectRoot, '.saivage', 'state'), { recursive: true });
    writeFileSync(path, '{malformed}\n');
    const mutation = createMutationLane();
    const store = new CandidateAvailabilityStore(projectRoot, mutation.lane);
    expect(() => store.restabilize(mutation.authority)).toThrow(/row 1 is malformed/);
  });

  it('compacts through atomic replacement without a lock or writer lifecycle', () => {
    const { projectRoot, store, authority } = setup(undefined, 200);
    for (let index = 0; index < 50; index += 1) {
      store.markFailed(authority, candidate, { state: 'COOLING', untilMs: Date.now() + 1000 + index, reason: `r${index}` });
    }
    expect(statSync(store.jsonlPath).size).toBeLessThanOrEqual(400);
    expect(existsSync(join(projectRoot, '.saivage', 'locks', 'provider-availability.lock'))).toBe(false);
    expect('dispose' in store).toBe(false);
  });

  it('rejects stale async authority before changing memory or disk', () => {
    const mutation = createMutationLane();
    const currentness = new RootCurrentness();
    const rootAuthority = currentness.installRoot();
    const leaf = currentness.installLeaf(rootAuthority);
    const projectRoot = root();
    const store = new CandidateAvailabilityStore(projectRoot, mutation.lane);
    store.restabilize(mutation.authority);
    currentness.clearLeaf(leaf);

    expect(() => store.markFailed(leaf, candidate, { state: 'COOLING', untilMs: Date.now() + 1000 })).toThrow(/stale/);
    expect(store.getEntry(candidate)).toBeUndefined();
    expect(existsSync(store.jsonlPath)).toBe(false);
  });
});
