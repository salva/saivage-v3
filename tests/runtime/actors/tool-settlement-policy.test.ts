import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { validateConversation } from '../../../src/contracts/conversation-validation.js';
import { canonicalJson, type AgentMessage, type ConversationSessionId } from '../../../src/schemas/index.js';
import { appendLlmTurnToolCallBatch, appendProviderVisibleSyntheticFailedToolResult, appendToolResult, InvocationResultPolicy, selectInvocationResultPolicy, settleToolResultForConversation } from '../../../src/runtime/actors/llm-delivery-log.js';
import type { CanonicalLlmInvocationInput, PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { compileInvocationToolContract, buildPreparedInvocationContext } from '../../../src/runtime/actors/context/context-blocks.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { executedNoneSettlement, executedProviderResult, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, syntheticToolSettlement, UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE } from '../../../src/tools/invocation.js';
import { initProjectTree } from '../../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const SESSION: ConversationSessionId = 'agent:planner:project';
const CANDIDATE = { provider: 'test', account: null, model: 'test-model' } as const;

function invocation(inputId: string, contracts: readonly InvocationContract[]): PreparedLlmInvocationInput {
  const preparedCompaction = prepareCompaction({ input_budget_tokens: 100_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler' }, 'system', []);
  return {
    inputId,
    agentId: SESSION,
    agentName: 'planner',
    sessionId: SESSION,
    systemPrompt: 'system',
    providerConversation: { sourceSessionId: SESSION, messages: [] },
    tools: contracts.map((contract) => contract.providerDefinition),
    compiledToolContracts: contracts,
    terminalToolNames: [],
    modelParams: { temperature: 0 },
    preparedCompaction,
    preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: contracts, dynamicBlocks: [], preparedCompaction }),
    capabilityRequest: {},
    routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] },
    episodeContext: {},
  };
}
type InvocationContract = ReturnType<typeof compileInvocationToolContract>;

function cardToolContract(name = 'get_card'): InvocationContract {
  return compileInvocationToolContract({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } }, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE);
}

function newRoot(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-tool-settlement-')); initProjectTree(root); roots.push(root); return root; }

const call = (inputId: string, toolCallId: string, name = 'get_card', args = '{}') => ({ id: toolCallId, type: 'function' as const, function: { name, arguments: args } });
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('typed tool settlement', () => {
  it('hashes observational evidence from the exact canonical settled bytes across arbitrary result shapes', () => {
    for (const data of [{ rows: [1, 2, 3] }, { nested: { deep: [{ leaf: 'x' }] } }, { unicode: 'ñá€𝄞' }, ['array', { mixed: true }], 'plain']) {
      const facts = settleToolResultForConversation('get_card', policyOf(cardToolContract()), { kind: 'executed', execution: { providerResult: { success: true, data }, evidence: { kind: 'observational_result_bytes' } } });
      expect(facts.settledResultBytes).toBe(canonicalJson({ success: true, data }));
      expect(facts.resultContentSha256).toBe(hash(facts.settledResultBytes));
      expect(facts.evidence).toEqual({ kind: 'observational_query', observedSha256: facts.resultContentSha256 });
      expect(facts.settlementOrigin).toBe('executed');
      expect(facts.providerResult).toEqual({ success: true, data });
    }
  });

  it('selects the unsupported policy before the call append and never consults the catalog for results', () => {
    const input = invocation(randomUUID(), []);
    const selected = selectInvocationResultPolicy(input, 'mystery_tool');
    expect(selected.resultPolicyTemplate).toEqual(UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE);
    const contract = selectInvocationResultPolicy(invocation(randomUUID(), [cardToolContract()]), 'get_card');
    expect(contract.resultPolicyTemplate).toEqual(OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE);
  });

  it('commits the compiled contract template bytes and hash on the call row and rejects drift', () => {
    const root = newRoot();
    const inputId = randomUUID();
    const input = invocation(inputId, [cardToolContract()]);
    const policy = selectInvocationResultPolicy(input, 'get_card');
    const appended = appendLlmTurnToolCallBatch({ projectRoot: root }, input, call(inputId, 'call-1'), policy);
    const row = readConversation(root, SESSION).physicalRows.find((message) => message.kind === 'tool_call')!;
    expect(row.id).toBe(appended.id);
    expect(row.context_policy).toEqual({ kind: 'tool_call', template: policy.resultPolicyTemplate, template_bytes: policy.resultPolicyTemplateBytes, template_sha256: policy.resultPolicyTemplateSha256 });
    const tampered: InvocationResultPolicy = { ...policy, resultPolicyTemplateBytes: '{}', resultPolicyTemplateSha256: hash('{}') };
    expect(() => appendLlmTurnToolCallBatch({ projectRoot: root }, invocation(randomUUID(), [cardToolContract()]), call(randomUUID(), 'call-2'), tampered)).toThrow(/does not commit to its canonical bytes/);
  });

  it('settles an executed result against its call pair and persists exactly the settled bytes', () => {
    const root = newRoot();
    const inputId = randomUUID();
    const input = invocation(inputId, [cardToolContract()]);
    const policy = selectInvocationResultPolicy(input, 'get_card');
    appendLlmTurnToolCallBatch({ projectRoot: root }, input, call(inputId, 'call-1'), policy);
    const facts = appendToolResult({ projectRoot: root }, {
      session_id: SESSION,
      source_input_id: inputId,
      tool_call_id: 'call-1',
      tool_name: 'get_card',
      resultPolicy: policy,
      settlement: { kind: 'executed', execution: { providerResult: { success: true, data: { card: 'a' } }, evidence: { kind: 'observational_result_bytes' } } },
    });
    const conversation = readConversation(root, SESSION);
    const result = conversation.physicalRows.find((message) => message.kind === 'tool_result')!;
    expect(result.content).toBe(facts.settledResultBytes);
    expect(result.context_policy).toEqual({ kind: 'tool_result', settlement_origin: 'executed', result_content_sha256: facts.resultContentSha256, call_policy_sha256: policy.resultPolicyTemplateSha256, evidence: facts.evidence });
    expect(() => validateConversation(SESSION, conversation.physicalRows)).not.toThrow();
  });

  it('rejects wrong execution evidence kinds at runtime', () => {
    const policy = policyOf(cardToolContract());
    expect(() => settleToolResultForConversation('get_card', policy, { kind: 'executed', execution: { providerResult: { success: true, data: {} }, evidence: { kind: 'none' } as never } })).toThrow(/observational result bytes/);
    const nonePolicy = policyOf(compileInvocationToolContract({ type: 'function', function: { name: 'write', description: 'w', parameters: { type: 'object' } } }, OPERATIONAL_RESULT_POLICY_TEMPLATE));
    expect(() => settleToolResultForConversation('write', nonePolicy, { kind: 'executed', execution: { providerResult: { success: true, data: {} }, evidence: { kind: 'observational_result_bytes' } as never } })).toThrow(/none evidence/);
    const canonicalPolicy = policyOf(compileInvocationToolContract({ type: 'function', function: { name: 'reader', description: 'r', parameters: { type: 'object' } } }, { ...OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, evidenceMode: 'canonical_locator' }));
    expect(() => settleToolResultForConversation('reader', canonicalPolicy, { kind: 'executed', execution: { providerResult: { success: true }, evidence: { kind: 'observational_result_bytes' } as never } })).toThrow(/canonical-locator/);
    expect(settleToolResultForConversation('reader', canonicalPolicy, { kind: 'executed', execution: { providerResult: { success: true, data: {} }, evidence: { kind: 'canonical_locator', locator: 'record:///a.md?card=project&v=1#entry=e1', sha256: hash('content') } } }).evidence)
      .toEqual({ kind: 'canonical_locator', locator: 'record:///a.md?card=project&v=1#entry=e1', sha256: hash('content') });
  });

  it('carries none evidence and the exact synthetic origin on every synthetic path', () => {
    for (const settlement of [
      syntheticToolSettlement('rejected_before_execution', 'arguments invalid'),
      syntheticToolSettlement('unsupported_tool', 'unknown tool'),
      syntheticToolSettlement('execution_failed', 'executor crashed', { code: 'x' }),
    ]) {
      const facts = settleToolResultForConversation(settlement.kind === 'unsupported_tool' ? 'mystery' : 'get_card', policyOf(cardToolContract()), settlement);
      expect(facts.evidence).toEqual({ kind: 'none' });
      expect(facts.settlementOrigin).toBe(settlement.kind);
      expect(facts.providerResult.success).toBe(false);
      expect(facts.settledResultBytes).toBe(canonicalJson(facts.providerResult));
    }
    const failedExecution = settleToolResultForConversation('get_card', policyOf(cardToolContract()), { kind: 'executed', execution: { providerResult: { success: false, error: 'domain refusal' }, evidence: { kind: 'none' } } });
    expect(failedExecution.evidence).toEqual({ kind: 'none' });
    expect(failedExecution.settlementOrigin).toBe('executed');
    expect(executedNoneSettlement({ success: true, data: { accepted: true } })).toEqual({ kind: 'executed', execution: { providerResult: { success: true, data: { accepted: true } }, evidence: { kind: 'none' } } });
    expect(executedProviderResult('observational_query', { success: false, error: 'x' }).evidence).toEqual({ kind: 'none' });
  });

  it('validates composite-identity pairing, rejection of orphans, repeats, name and commitment mismatches', () => {
    const root = newRoot();
    const firstInput = randomUUID();
    const secondInput = randomUUID();
    const input = invocation(firstInput, [cardToolContract()]);
    const policy = selectInvocationResultPolicy(input, 'get_card');
    const rows = () => readConversation(root, SESSION).physicalRows;
    const appendSettled = (sourceInputId: string, toolName: string, resultPolicy: InvocationResultPolicy) =>
      appendToolResult({ projectRoot: root }, { session_id: SESSION, source_input_id: sourceInputId, tool_call_id: 'shared-call', tool_name: toolName, resultPolicy, settlement: { kind: 'executed', execution: { providerResult: { success: true, data: {} }, evidence: { kind: 'observational_result_bytes' } } } });

    appendLlmTurnToolCallBatch({ projectRoot: root }, input, call(firstInput, 'shared-call'), policy);
    expect(() => appendSettled(secondInput, 'get_card', policy)).toThrow(/no matching earlier call/);
    expect(() => appendSettled(firstInput, 'get_card', policy)).not.toThrow();
    appendLlmTurnToolCallBatch({ projectRoot: root }, invocation(secondInput, [cardToolContract()]), call(secondInput, 'shared-call'), policy);
    expect(() => appendSettled(secondInput, 'get_card', policy)).not.toThrow();
    expect(() => validateConversation(SESSION, rows())).not.toThrow();
    expect(() => appendSettled(firstInput, 'get_card', policy)).toThrow(/duplicate tool result identity|already exists/);
    expect(() => appendConversationBatch({ projectRoot: root }, [settledRow(randomUUID(), 'orphan-1')])).toThrow(/no matching earlier call/);
    expect(() => appendConversationBatch({ projectRoot: root }, [settledRow(randomUUID(), 'shared-call', 'read')])).toThrow(/same identity and tool name/);
    const wrongCommitment = { ...settledRow(randomUUID(), 'late-1', 'get_card') };
    if (wrongCommitment.context_policy.kind === 'tool_result') wrongCommitment.context_policy = { ...wrongCommitment.context_policy, call_policy_sha256: '0'.repeat(64) };
    expect(() => appendConversationBatch({ projectRoot: root }, [wrongCommitment])).toThrow(/does not commit to its call's policy template hash|tool result has no matching earlier call/);
  });

  it('keeps the sole final unmatched call primary-visible and rejects a second unmatched call', () => {
    const root = newRoot();
    const inputId = randomUUID();
    const input = invocation(inputId, [cardToolContract()]);
    const policy = selectInvocationResultPolicy(input, 'get_card');
    appendLlmTurnToolCallBatch({ projectRoot: root }, input, call(inputId, 'waiting'), policy);
    const conversation = readConversation(root, SESSION);
    expect(conversation.unmatchedCall?.toolCallId).toBe('waiting');
    expect(conversation.unmatchedCall?.message).toBe(conversation.physicalRows.at(-1));
    const second = invocation(randomUUID(), [cardToolContract()]);
    expect(() => appendLlmTurnToolCallBatch({ projectRoot: root }, second, call(second.inputId, 'waiting-2'), selectInvocationResultPolicy(second, 'get_card'))).toThrow(/more than one unmatched tool call/);
  });

  it('settles recovery interruptions with execution_failed synthetic none under the call policy', () => {
    const root = newRoot();
    const inputId = randomUUID();
    const input = invocation(inputId, [cardToolContract()]);
    const policy = selectInvocationResultPolicy(input, 'get_card');
    appendLlmTurnToolCallBatch({ projectRoot: root }, input, call(inputId, 'call-1'), policy);
    appendProviderVisibleSyntheticFailedToolResult({ projectRoot: root }, { sessionId: SESSION, sourceInputId: inputId, toolCallId: 'call-1', toolName: 'get_card', error: 'Runtime activation was interrupted before completion.', data: { outcome_unknown: true }, resultPolicy: policy });
    const result = readConversation(root, SESSION).physicalRows.find((message) => message.kind === 'tool_result')!;
    expect(result.context_policy).toMatchObject({ kind: 'tool_result', settlement_origin: 'execution_failed', evidence: { kind: 'none' }, call_policy_sha256: policy.resultPolicyTemplateSha256 });
    expect(() => validateConversation(SESSION, readConversation(root, SESSION).physicalRows)).not.toThrow();
  });
});

function policyOf(contract: InvocationContract): InvocationResultPolicy {
  return { resultPolicyTemplate: contract.resultPolicyTemplate, resultPolicyTemplateBytes: contract.resultPolicyTemplateBytes, resultPolicyTemplateSha256: contract.resultPolicyTemplateSha256 };
}

function settledRow(sourceInputId: string, toolCallId: string, toolName = 'get_card'): AgentMessage {
  const policy = policyOf(cardToolContract(toolName));
  const content = canonicalJson({ success: true, data: { settled: true } });
  return {
    id: `${sourceInputId}:tool-result:${toolCallId}`,
    session_id: SESSION,
    role: 'tool',
    kind: 'tool_result',
    tool: toolName,
    tool_call_id: toolCallId,
    content,
    context_policy: { kind: 'tool_result', settlement_origin: 'executed', result_content_sha256: hash(content), call_policy_sha256: policy.resultPolicyTemplateSha256, evidence: { kind: 'observational_query', observedSha256: hash(content) } },
    round_id: `r-user-${'0'.repeat(32)}`,
    message_index: 2,
    block_index: 0,
    timestamp: '2026-08-17T00:00:00.000Z',
  };
}
