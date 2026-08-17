import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLlmTurnToolCallBatch, appendProviderVisibleSyntheticFailedToolResult, appendToolResult } from '../../src/runtime/actors/llm-delivery-log.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { CanonicalLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { preparedInvocationContextFixture } from '../helpers/prepared-invocation-context.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

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

  it('removes obsolete runtime lock and conversation-barrel exports', async () => {
    const [lock, actors] = await Promise.all([
      import('../../src/runtime/lock.js'),
      import('../../src/runtime/actors/index.js'),
    ]);

    expect('parseRuntimeLockOwnerRecord' in lock).toBe(false);
    expect('isLocked' in lock).toBe(false);
    expect('parseConversationSessionId' in actors).toBe(false);
  });

  it('keeps only consumed delivery-log exports and return members', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-delivery-contract-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const inputId = '00000000-0000-4000-8000-000000000001';
    const invocation: CanonicalLlmInvocationInput = { inputId, agentId: 'agent:planner:project', agentName: 'planner', sessionId: 'agent:planner:project', ...preparedInvocationContextFixture(), providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, modelParams: { temperature: 0, maxTokens: 2000 }, capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [{ provider: 'test', account: null, model: 'test-model' }] }, episodeContext: {} };
    appendLlmTurnToolCallBatch({ projectRoot }, invocation, { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } });

    const settlement = appendToolResult({ projectRoot }, { session_id: 'agent:planner:project', source_input_id: inputId, tool_call_id: 'call-1', tool_name: 'read', result: { success: true } });
    expect(settlement).toMatchObject({ source_input_id: inputId, tool_call_id: 'call-1', tool_name: 'read', result: { success: true } });
    expect('message' in settlement).toBe(false);

    const secondInputId = '00000000-0000-4000-8000-000000000002';
    appendLlmTurnToolCallBatch({ projectRoot }, { ...invocation, inputId: secondInputId }, { id: 'call-2', type: 'function', function: { name: 'write', arguments: '{}' } });
    expect(appendProviderVisibleSyntheticFailedToolResult({ projectRoot }, { sessionId: 'agent:planner:project', sourceInputId: secondInputId, toolCallId: 'call-2', toolName: 'write', error: 'interrupted' })).toBeUndefined();

    const delivery = await import('../../src/runtime/actors/llm-delivery-log.js');
    expect('appendLlmTurnMessage' in delivery).toBe(false);
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

    expect(schemas.runtimeStatusSchema).toBeDefined();
    expect(schemas.runtimeStatusSchema.safeParse('uninitialized').success).toBe(false);
    expect(schemas.eventKindValues).toEqual([
      'runtime_diagnostic',
      'runtime_actionable_error',
      'mcp_tool_invocation',
    ]);
  });

  it('keeps the internal initialization state out of public and web runtime contracts', () => {
    for (const relativePath of [
      'src/schemas/types.ts',
      'src/schemas/validators.ts',
      'src/contracts/operator-api-runtime-cards.ts',
      'web/src/api/contracts.ts',
      'web/src/api/types.ts',
    ]) {
      expect(readFileSync(join(process.cwd(), relativePath), 'utf8')).not.toContain('uninitialized');
    }
  });

  it('removes rework results and admits only the exact workflow result in the card lifecycle schema', async () => {
    const schemas = await import('../../src/schemas/index.js');
    const schemaIndexSource = readFileSync(join(process.cwd(), 'src/schemas/index.ts'), 'utf8');
    expect(schemaIndexSource).not.toContain('ReworkResult');
    expect(schemaIndexSource).not.toContain('reworkResultSchema');
    expect('ReworkResult' in schemas).toBe(false);
    expect('reworkResultSchema' in schemas).toBe(false);

    const blockedResult = { kind: 'workflow-result',terminal:'BLOCKED',agent_name:'executor',node_id:'execute',outcome:'blocked',summary:'waiting',records:[] };
    const reworkResult = { kind: 'rework', summary: 'revise', feedback: 'incorrect' };
    expect(schemas.cardLifecycleStateSchema.parse({ status: 'blocked', result: blockedResult, error: 'waiting', completed_at: null }))
      .toEqual({ status: 'blocked', result: blockedResult, error: 'waiting', completed_at: null });

    expect(schemas.cardLifecycleStateSchema.safeParse({ status: 'blocked', result: reworkResult, error: 'revise', completed_at: null }).success).toBe(false);
  });
});
