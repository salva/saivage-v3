import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

type LedgerRow = { openAttempts: number; descriptorReads: number; pathReads: number; closes: number };
type Scenario = 'valid' | 'malformed' | 'empty-malformed' | 'empty-live-malformed' | 'models' | 'models-malformed';
type ChildResult = {
  scenario: Scenario;
  paths: Record<'analyst' | 'planner' | 'reviewer' | 'app', string>;
  ledger: Record<string, LedgerRow>;
  sessions: Array<{ id: string; model?: string }> | null;
  error: string | null;
};

const fixture = join(process.cwd(), 'tests', 'fixtures', 'conversation-inventory-read-count-child.ts');

describe('aggregate conversation inventory physical reads', () => {
  it('opens every exact candidate once, reads each present file once, and projects without rereading', () => {
    const result = runChild('valid');
    expect(result.error).toBeNull();
    expect(result.sessions?.map(({ id }) => id)).toEqual(['agent:planner:project', 'agent:reviewer:project']);
    expect(result.ledger[result.paths.analyst]).toEqual({ openAttempts: 1, descriptorReads: 0, pathReads: 0, closes: 0 });
    expect(result.ledger[result.paths.planner]).toEqual({ openAttempts: 1, descriptorReads: 1, pathReads: 0, closes: 1 });
    expect(result.ledger[result.paths.reviewer]).toEqual({ openAttempts: 1, descriptorReads: 1, pathReads: 0, closes: 1 });
  });

  it('reads a present complete malformed candidate once and fails with its canonical data error', () => {
    const result = runChild('malformed');
    expect(result.sessions).toBeNull();
    expect(result.error).toMatch(/Growing file '.*planner\.jsonl' envelope 1 is malformed/);
    expect(result.ledger[result.paths.analyst]).toEqual({ openAttempts: 1, descriptorReads: 0, pathReads: 0, closes: 0 });
    expect(result.ledger[result.paths.planner]).toEqual({ openAttempts: 1, descriptorReads: 1, pathReads: 0, closes: 1 });
    expect(result.ledger[result.paths.reviewer]).toEqual({ openAttempts: 0, descriptorReads: 0, pathReads: 0, closes: 0 });
    expect(result.ledger[result.paths.app]).toEqual({ openAttempts: 0, descriptorReads: 0, pathReads: 0, closes: 0 });
  });

  it.each([
    { scenario: 'empty-malformed' as const, expectedError: null },
    { scenario: 'empty-live-malformed' as const, expectedError: "Executing agent snapshot 'agent:planner:project' has no aggregate conversation row." },
  ])('does not access the malformed app log for $scenario inventory', ({ scenario, expectedError }) => {
    const result = runChild(scenario);
    expect(result.sessions).toEqual(expectedError === null ? [] : null);
    expect(result.error).toBe(expectedError);
    expect(result.ledger[result.paths.app]).toEqual({ openAttempts: 0, descriptorReads: 0, pathReads: 0, closes: 0 });
  });

  it('reads the app log exactly once for a non-empty multi-session inventory and projects each model', () => {
    const result = runChild('models');
    expect(result.error).toBeNull();
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: 'agent:planner:project', model: 'planner-model' }),
      expect.objectContaining({ id: 'agent:reviewer:project', model: 'reviewer-model' }),
    ]);
    expect(result.ledger[result.paths.app]).toEqual({ openAttempts: 1, descriptorReads: 1, pathReads: 0, closes: 1 });
  });

  it('reads a malformed app log exactly once for non-empty inventory before propagating strict failure', () => {
    const result = runChild('models-malformed');
    expect(result.sessions).toBeNull();
    expect(result.error).toMatch(/app\.jsonl.*malformed/);
    expect(result.ledger[result.paths.app]).toEqual({ openAttempts: 1, descriptorReads: 1, pathReads: 0, closes: 1 });
  });
});

function runChild(scenario: Scenario): ChildResult {
  const child = spawnSync(process.execPath, ['--import', 'tsx', fixture, scenario], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Conversation inventory child failed (${child.status}): ${child.stderr || child.stdout}`);
  try { return JSON.parse(child.stdout.trim()) as ChildResult; }
  catch (error) { throw new Error(`Conversation inventory child emitted an invalid ledger: ${child.stdout}`, { cause: error }); }
}
