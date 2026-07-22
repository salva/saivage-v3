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
    expect(schemas.eventKindValues).toEqual([
      'runtime_diagnostic',
      'runtime_actionable_error',
      'mcp_tool_invocation',
    ]);
  });

  it('removes rework results and admits only the exact workflow result in every shared runtime schema', async () => {
    const schemas = await import('../../src/schemas/index.js');
    const schemaIndexSource = readFileSync(join(process.cwd(), 'src/schemas/index.ts'), 'utf8');
    expect(schemaIndexSource).not.toContain('ReworkResult');
    expect(schemaIndexSource).not.toContain('reworkResultSchema');
    expect('ReworkResult' in schemas).toBe(false);
    expect('reworkResultSchema' in schemas).toBe(false);

    const blockedResult = { kind: 'workflow-result',terminal:'BLOCKED',agent_name:'executor',node_id:'execute',outcome:'blocked',summary:'waiting',records:[] };
    const reworkResult = { kind: 'rework', summary: 'revise', feedback: 'incorrect' };
    expect(schemas.cardResultSchema.parse(blockedResult)).toEqual(blockedResult);
    expect(schemas.cardLifecycleStateSchema.parse({ status: 'blocked', result: blockedResult, error: 'waiting', completed_at: null }))
      .toEqual({ status: 'blocked', result: blockedResult, error: 'waiting', completed_at: null });
    expect(schemas.activationOutcomeSchema.parse({ outcome: 'blocked', result: blockedResult, error: 'waiting' }))
      .toEqual({ outcome: 'blocked', result: blockedResult, error: 'waiting' });
    expect(schemas.runtimeRunOutcomeSchema.parse({ outcome: 'blocked', result: blockedResult, error: 'waiting' }))
      .toEqual({ outcome: 'blocked', result: blockedResult, error: 'waiting' });

    expect(schemas.cardResultSchema.safeParse(reworkResult).success).toBe(false);
    expect(schemas.cardLifecycleStateSchema.safeParse({ status: 'blocked', result: reworkResult, error: 'revise', completed_at: null }).success).toBe(false);
    expect(schemas.activationOutcomeSchema.safeParse({ outcome: 'blocked', result: reworkResult, error: 'revise' }).success).toBe(false);
    expect(schemas.runtimeRunOutcomeSchema.safeParse({ outcome: 'blocked', result: reworkResult, error: 'revise' }).success).toBe(false);
  });
});
