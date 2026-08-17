import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendLlmTurnToolCallBatch, appendToolResult } from '../../../src/runtime/actors/llm-delivery-log.js';
import { appendActivationMarker, appendRecoveryNotice, providerConversationProjection } from '../../../src/runtime/actors/conversation-session.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { compileInvocationToolContract, OBSERVATIONAL_TOOL_RESULT_POLICY_TEMPLATE, CANONICAL_TOOL_RESULT_POLICY_TEMPLATE, prepareInvocationContext } from '../../../src/runtime/actors/llm-invocation.js';
import { canonicalToolExecution, executedToolSettlement, observationalToolExecution } from '../../../src/tools/invocation.js';
import { agentMessageSchema, canonicalJson } from '../../../src/schemas/index.js';
import { deterministicRoundId } from '../../../src/schemas/round-id-server.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { validateConversation } from '../../../src/contracts/conversation-validation.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('call-owned tool policy and result-owned settlement', () => {
  it('serializes an observational provider result once and derives evidence without leaking it', () => {
    const fixture = setup('read', OBSERVATIONAL_TOOL_RESULT_POLICY_TEMPLATE);
    const providerResult = { success: true as const, data: { z: 1, a: 'visible' } };
    const settled = appendToolResult({ projectRoot: fixture.root }, { session_id: fixture.sessionId, source_input_id: fixture.input.inputId, tool_call_id: 'same-id', tool_name: 'read', settlement: executedToolSettlement(OBSERVATIONAL_TOOL_RESULT_POLICY_TEMPLATE, observationalToolExecution(providerResult)), call_policy_sha256: fixture.callPolicySha256 });
    const result = readConversation(fixture.root, fixture.sessionId).sourceRows.at(-1)!;
    const expectedBytes = canonicalJson(providerResult);
    const expectedHash = createHash('sha256').update(expectedBytes, 'utf8').digest('hex');
    expect(result.content).toBe(expectedBytes);
    expect(result.context_policy).toEqual({ kind: 'tool_result', settlement_origin: 'executed', result_content_sha256: expectedHash, call_policy_sha256: fixture.callPolicySha256, evidence: { kind: 'observational_query', observedSha256: expectedHash } });
    expect(settled.providerResult).toEqual(providerResult);
    expect(result.content).not.toContain('observedSha256');

    const rows = readConversation(fixture.root, fixture.sessionId).sourceRows;
    const callIndex = rows.findIndex((row) => row.kind === 'tool_call');
    const resultIndex = rows.findIndex((row) => row.kind === 'tool_result');
    const call = rows[callIndex]!;
    if (call.context_policy.kind !== 'tool_call' || result.context_policy.kind !== 'tool_result') throw new Error('missing pair policy');
    expect(() => validateConversation(fixture.sessionId, replaced(rows, callIndex, agentMessageSchema.parse({ ...call, context_policy: { ...call.context_policy, template_bytes: '{}' } })))).toThrow(/policy bytes\/hash/);
    expect(() => validateConversation(fixture.sessionId, replaced(rows, resultIndex, agentMessageSchema.parse({ ...result, context_policy: { ...result.context_policy, call_policy_sha256: 'f'.repeat(64) } })))).toThrow(/call-policy commitment/);
    expect(() => validateConversation(fixture.sessionId, replaced(rows, resultIndex, agentMessageSchema.parse({ ...result, context_policy: { ...result.context_policy, evidence: { kind: 'canonical_locator', locator: 'card:///wrong', sha256: 'e'.repeat(64) } } })))).toThrow(/evidence does not match/);
    expect(() => validateConversation(fixture.sessionId, replaced(rows, resultIndex, agentMessageSchema.parse({ ...result, context_policy: { ...result.context_policy, settlement_origin: 'unsupported_tool' } })))).toThrow(/Synthetic tool result/);
  });

  it('keeps canonical executor evidence internal and correlates repeated provider ids by source input', () => {
    const first = setup('get_card_version', CANONICAL_TOOL_RESULT_POLICY_TEMPLATE);
    appendToolResult({ projectRoot: first.root }, { session_id: first.sessionId, source_input_id: first.input.inputId, tool_call_id: 'same-id', tool_name: 'get_card_version', settlement: executedToolSettlement(CANONICAL_TOOL_RESULT_POLICY_TEMPLATE, canonicalToolExecution({ success: true, data: { page: 1 } }, { locator: 'card:///project?v=1#entry=e', sha256: 'a'.repeat(64) })), call_policy_sha256: first.callPolicySha256 });
    const secondInput = { ...first.input, inputId: '22222222-2222-4222-8222-222222222222' };
    const secondCall = appendLlmTurnToolCallBatch({ projectRoot: first.root }, secondInput, { id: 'same-id', type: 'function', function: { name: 'get_card_version', arguments: '{"card_id":"project","version":2}' } });
    if (secondCall.context_policy.kind !== 'tool_call') throw new Error('missing second call policy');
    appendToolResult({ projectRoot: first.root }, { session_id: first.sessionId, source_input_id: secondInput.inputId, tool_call_id: 'same-id', tool_name: 'get_card_version', settlement: executedToolSettlement(CANONICAL_TOOL_RESULT_POLICY_TEMPLATE, canonicalToolExecution({ success: true, data: { page: 2 } }, { locator: 'card:///project?v=2#entry=f', sha256: 'b'.repeat(64) })), call_policy_sha256: secondCall.context_policy.template_sha256 });
    const conversation = readConversation(first.root, first.sessionId);
    expect(conversation.calls.map(({ sourceInputId, toolCallId, settledPolicy }) => ({ sourceInputId, toolCallId, evidence: settledPolicy?.evidence }))).toEqual([
      { sourceInputId: first.input.inputId, toolCallId: 'same-id', evidence: { kind: 'canonical_locator', locator: 'card:///project?v=1#entry=e', sha256: 'a'.repeat(64) } },
      { sourceInputId: secondInput.inputId, toolCallId: 'same-id', evidence: { kind: 'canonical_locator', locator: 'card:///project?v=2#entry=f', sha256: 'b'.repeat(64) } },
    ]);
  });

  it('projects the exact model recovery notice as model-facing system semantics', () => {
    const root = freshRoot();
    const sessionId = 'agent:planner:project' as const;
    const inputId = '11111111-1111-4111-8111-111111111111';
    appendActivationMarker({ projectRoot: root }, sessionId, { event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId });
    const notice = appendRecoveryNotice({ projectRoot: root }, sessionId, inputId, 'ordinary_interruption');
    expect(notice.context_policy).toEqual({ kind: 'structural', behavior: 'model_recovery_notice' });
    expect(providerConversationProjection(readConversation(root, sessionId)).messages).toContainEqual(notice);
    const wrongInput = '33333333-3333-4333-8333-333333333333';
    const wrongIdentity = agentMessageSchema.parse({ ...notice, id: `${wrongInput}:model-recovered`, round_id: deterministicRoundId('pre', wrongInput) });
    expect(() => appendConversationBatch({ projectRoot: root }, [wrongIdentity])).toThrow(/current activation identity/);
  });
});

function setup(name: string, template: typeof OBSERVATIONAL_TOOL_RESULT_POLICY_TEMPLATE | typeof CANONICAL_TOOL_RESULT_POLICY_TEMPLATE) {
  const root = freshRoot();
  const sessionId = 'agent:planner:project' as const;
  const compiled = compileInvocationToolContract({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } }, template);
  const prepared = prepareInvocationContext({ instructionText: 'system', compiledTools: [compiled], terminalToolNames: [], dynamicBlocks: [] });
  const input = { inputId: '11111111-1111-4111-8111-111111111111', agentId: sessionId, agentName: 'planner' as const, sessionId, ...prepared, providerConversation: { sourceSessionId: sessionId, messages: [] }, modelParams: { temperature: 0 }, preparedCompaction: prepareCompaction({ input_budget_tokens: 1000, trigger_fraction: .8, completion_reserve_fraction: .2, merge_line_fraction: .3, summary_line_fraction: .5, escalate_merge_line_fraction: .4, escalate_summary_line_fraction: .6, snap: 'compact_straddler' }, 'system', [], 100), capabilityRequest: {}, routePass: { kind: 'ordinary' as const, candidateChain: [{ provider: 'test', account: null, model: 'test' }] }, episodeContext: {} };
  appendActivationMarker({ projectRoot: root }, sessionId, { event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: input.inputId });
  const call = appendLlmTurnToolCallBatch({ projectRoot: root }, input, { id: 'same-id', type: 'function', function: { name, arguments: '{}' } });
  if (call.context_policy.kind !== 'tool_call') throw new Error('missing call policy');
  return { root, sessionId, input, callPolicySha256: call.context_policy.template_sha256 };
}

function freshRoot(): string { const root = mkdtempSync(join(tmpdir(), 'tool-policy-')); roots.push(root); initProjectTree(root); return root; }
function replaced<T>(values: readonly T[], index: number, value: T): T[] { const result = [...values]; result[index] = value; return result; }
