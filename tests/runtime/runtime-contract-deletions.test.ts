import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('runtime ledger contract deletions', () => {
  it('keeps start/stop runtime results current-state-only', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime-api.ts'), 'utf8');
    expect(source).toContain('runtime: RuntimeState | null');
    expect(source).toContain('started: boolean');
    expect(source).toContain('stopped: boolean');
    expect(source).not.toContain('RuntimeCommandRecord');
    expect(source).not.toContain('RuntimeRunRecord');
    expect(source).not.toContain('command:');
    expect(source).not.toContain('run:');
  });

  it('removes public runtime ledger contract exports', async () => {
    const contracts = await import('../../src/contracts/index.js');
    expect('RuntimeCommandRecordSchema' in contracts).toBe(false);
    expect('RuntimeRunRecordSchema' in contracts).toBe(false);
    expect('RuntimeActivationRecordSchema' in contracts).toBe(false);
    expect('RuntimeActivationLedgerPort' in contracts).toBe(false);
  });

  it('removes obsolete schema values while retaining current runtime and logged-event values', async () => {
    const schemas = await import('../../src/schemas/index.js');

    for (const removed of [
      'runtimeDispatchOwnershipSchema',
      'activationCompletionOutcomeSchema',
      'activationCompletionEnvelopeV1Schema',
      'createActivationCompletionEnvelope',
      'parseActivationCompletionEnvelope',
      'runtimeRunStatusSchema',
      'handoffSummarySchema',
    ]) {
      expect(removed in schemas).toBe(false);
    }

    expect(schemas.activationOutcomeSchema).toBeDefined();
    expect(schemas.runtimeStatusSchema).toBeDefined();
    expect(schemas.runtimeRunOutcomeSchema).toBeDefined();
    expect(schemas.eventKindValues).toEqual(expect.arrayContaining([
      'control_action_record_appended',
      'event_log_record_appended',
      'error_log_record_appended',
    ]));
  });
});
