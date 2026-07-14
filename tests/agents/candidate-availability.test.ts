import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { CandidateAvailabilityStore } from '../../src/agents/candidate-availability-store.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';

const candidate: Candidate = { provider: 'p', account: 'a', model: 'm' };
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'saivage-availability-'));
  roots.push(value);
  return value;
}

function setup(projectRoot = root()) {
  const store = new CandidateAvailabilityStore(projectRoot, new ApplicationPersistenceHealth());
  store.restabilize();
  return { projectRoot, store };
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.length = 0;
});

describe('MemoryCandidateAvailability', () => {
  it('applies availability transitions and preserves the longest active block', () => {
    const store = new MemoryCandidateAvailability();
    expect(store.isAvailable(candidate)).toBe(true);
    const strongest = Date.now() + 120_000;
    store.markFailed(candidate, { state: 'BLOCKED_UNTIL', untilMs: strongest, reason: 'rate_limit' });
    store.markFailed(candidate, { state: 'COOLING', untilMs: Date.now() + 5_000, reason: 'transient' });
    expect(store.getEntry(candidate)?.untilMs).toBe(strongest);
    store.markSucceeded(candidate);
    expect(store.isAvailable(candidate)).toBe(true);
  });
});

describe('CandidateAvailabilityStore', () => {
  it('persists complete fsynced rows and strictly replays them in a fresh owner', () => {
    const projectRoot = root();
    const first = setup(projectRoot);
    const untilMs = Date.now() + 60_000;
    first.store.markFailed(candidate, { state: 'BLOCKED_UNTIL', untilMs, reason: 'rate_limit' });

    const second = setup(projectRoot);
    expect(second.store.getEntry(candidate)).toMatchObject({ untilMs, state: 'BLOCKED_UNTIL', reason: 'rate_limit' });
    expect(readFileSync(second.store.jsonlPath, 'utf8').endsWith('\n')).toBe(true);
  });

  it('discards only an incomplete final tail during startup restabilization', () => {
    const projectRoot = root();
    const first = setup(projectRoot);
    first.store.markSucceeded(candidate);
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
    const store = new CandidateAvailabilityStore(projectRoot, new ApplicationPersistenceHealth());
    expect(() => store.restabilize()).toThrow(/envelope 1 is malformed/);
  });

});
