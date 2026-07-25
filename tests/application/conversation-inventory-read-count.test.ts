import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

type Ledger = { openAttempts: number; readCalls: number; bytesRead: number; closes: number };
type ChildResult = {
  paths: Record<'analyst' | 'planner' | 'reviewer' | 'app', string>;
  ledger: Record<string, Ledger>;
  firstEnvelopeBytes: Record<'analyst' | 'planner' | 'reviewer' | 'app', number>;
  sessions: Array<{ id: string }> | null;
  error: string | null;
};

describe('Agent inventory first-envelope physical reads', () => {
  it('opens each exact candidate once, reads exactly its first envelope, and never opens app log', () => {
    const result = runChild('valid');
    expect(result.error).toBeNull();
    expect(result.sessions?.map(({ id }) => id)).toEqual([
      'agent:planner:project',
      'agent:reviewer:project',
    ]);
    expect(result.ledger[result.paths.analyst]).toEqual(zeroLedger(1));
    for (const key of ['planner', 'reviewer'] as const) {
      expect(result.ledger[result.paths[key]]).toEqual({
        openAttempts: 1,
        readCalls: result.firstEnvelopeBytes[key],
        bytesRead: result.firstEnvelopeBytes[key],
        closes: 1,
      });
    }
    expect(result.ledger[result.paths.app]).toEqual(zeroLedger(0));
  });

  it('fails a malformed first envelope but leaves malformed later history unread', () => {
    const malformedFirst = runChild('malformed-first');
    expect(malformedFirst.error).toMatch(/malformed/i);
    expect(malformedFirst.ledger[malformedFirst.paths.reviewer]).toEqual(zeroLedger(0));

    const malformedLater = runChild('malformed-later');
    expect(malformedLater.error).toBeNull();
    expect(malformedLater.sessions?.map(({ id }) => id)).toEqual([
      'agent:planner:project',
      'agent:reviewer:project',
    ]);
    expect(malformedLater.ledger[malformedLater.paths.planner].bytesRead).toBe(
      malformedLater.firstEnvelopeBytes.planner,
    );
    expect(malformedLater.ledger[malformedLater.paths.app]).toEqual(zeroLedger(0));
  });
});

function runChild(scenario: string): ChildResult {
  const script = fileURLToPath(
    new URL('../fixtures/conversation-inventory-read-count-child.ts', import.meta.url),
  );
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', script, scenario], {
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim()) as ChildResult;
}

function zeroLedger(openAttempts: number): Ledger {
  return { openAttempts, readCalls: 0, bytesRead: 0, closes: 0 };
}
