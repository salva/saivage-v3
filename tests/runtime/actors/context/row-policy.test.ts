import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import { canonicalJson, DURABLE_PRIMARY_CONTENT_POLICY, STRUCTURAL_ROW_POLICY, type AgentMessage, type ConversationSessionId, type RowContextPolicy, type ToolResultPolicyTemplate } from '../../../../src/schemas/index.js';
import { classifyConversationRowPolicy, settledToolBundlePolicy } from '../../../../src/runtime/actors/context/row-policy.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE } from '../../../../src/tools/invocation.js';

const SESSION: ConversationSessionId = 'agent:planner:project';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const TS = '2026-08-17T00:00:00.000Z';

function row(partial: Omit<AgentMessage, 'session_id' | 'context_policy' | 'round_id' | 'message_index' | 'block_index' | 'timestamp'> & Partial<Pick<AgentMessage, 'context_policy' | 'round_id'>>): AgentMessage {
  return { session_id: SESSION, round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: TS, context_policy: DURABLE_PRIMARY_CONTENT_POLICY, ...partial } as AgentMessage;
}

function callRow(template: ToolResultPolicyTemplate = UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE, name = 'get_card'): AgentMessage {
  const template_bytes = canonicalJson(template);
  return row({
    id: `${SOURCE}:tool-call:call-1`,
    role: 'assistant',
    kind: 'tool_call',
    tool: name,
    tool_call_id: 'call-1',
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: '{"id":"card-a"}' } }] }),
    context_policy: { kind: 'tool_call', template, template_bytes, template_sha256: createHash('sha256').update(template_bytes, 'utf8').digest('hex') },
  });
}

function resultRow(content: unknown, policy: RowContextPolicy): AgentMessage {
  const settled = typeof content === 'string' ? content : canonicalJson(content);
  return row({
    id: `${SOURCE}:tool-result:call-1`,
    role: 'tool',
    kind: 'tool_result',
    tool: 'get_card',
    tool_call_id: 'call-1',
    content: settled,
    context_policy: policy,
  });
}

describe('conversation row policy classification', () => {
  it('classifies every current MessageKind exactly once with the plan table semantics', () => {
    const text = classifyConversationRowPolicy(row({ id: 't', role: 'assistant', kind: 'text', content: 'x' }));
    expect(text).toMatchObject({ kind: 'content', projection: { audience: 'primary_and_summarizer', primaryVisible: true, summaryEligible: true, rendering: 'direct' } });
    expect(classifyConversationRowPolicy(row({ id: 'a', role: 'system', kind: 'activity', content: '{}', context_policy: STRUCTURAL_ROW_POLICY.activation_boundary })))
      .toMatchObject({ kind: 'structural', projection: { behavior: 'activation_boundary', primaryVisible: false, summaryEligible: false } });
    expect(classifyConversationRowPolicy(row({ id: 'mi', role: 'assistant', kind: 'model_issue', content: 'x', context_policy: STRUCTURAL_ROW_POLICY.provider_failure })))
      .toMatchObject({ kind: 'structural', projection: { behavior: 'provider_failure', primaryVisible: false, summaryEligible: false } });
    expect(classifyConversationRowPolicy(row({ id: 'mr', role: 'user', kind: 'model_repair', content: 'x' })))
      .toMatchObject({ kind: 'content', projection: { rendering: 'direct' } });
    expect(classifyConversationRowPolicy(row({ id: 'cpr', role: 'user', kind: 'content_policy_retry', content: 'x' })))
      .toMatchObject({ kind: 'content', projection: { rendering: 'code_owned_retry_text' } });
    expect(classifyConversationRowPolicy(row({ id: 'cpf', role: 'system', kind: 'content_policy_refusal', content: '{}', context_policy: STRUCTURAL_ROW_POLICY.content_policy_refusal })))
      .toMatchObject({ kind: 'structural', projection: { behavior: 'content_policy_refusal', rendering: 'synthetic_refusal_text', primaryVisible: true, summaryEligible: true } });
    expect(classifyConversationRowPolicy(row({ id: 'mrc', role: 'system', kind: 'model_recovered', content: 'x', context_policy: STRUCTURAL_ROW_POLICY.model_recovery_notice })))
      .toMatchObject({ kind: 'structural', projection: { behavior: 'model_recovery_notice', rendering: 'synthetic_system_notice', primaryVisible: true, summaryEligible: true } });
    expect(classifyConversationRowPolicy(row({ id: 'pp', role: 'system', kind: 'provider_private', content: '{}', context_policy: STRUCTURAL_ROW_POLICY.responses_private })))
      .toMatchObject({ kind: 'structural', projection: { behavior: 'responses_private', rendering: 'paired_with_marked_visible_mate', primaryVisible: false, summaryEligible: false } });
    expect(classifyConversationRowPolicy(callRow())).toMatchObject({ kind: 'tool_exchange', projection: { bundle: 'call_template_only' } });
    expect(classifyConversationRowPolicy(resultRow({ success: true }, { kind: 'tool_result', settlement_origin: 'executed', result_content_sha256: '0'.repeat(64), call_policy_sha256: '0'.repeat(64), evidence: { kind: 'none' } })))
      .toMatchObject({ kind: 'tool_exchange', projection: { bundle: 'settled_pair' } });
  });

  it('requires a content policy on content-classified rows', () => {
    const missing = row({ id: 't', role: 'assistant', kind: 'text', content: 'x' });
    const structural = { ...missing, context_policy: STRUCTURAL_ROW_POLICY.activation_boundary };
    expect(() => classifyConversationRowPolicy(structural as never)).toThrow(/missing its content policy/);
  });
});

describe('settled tool bundle policy derivation', () => {
  const observedSha = createHash('sha256').update(canonicalJson({ success: true, data: { card: 'a' } }), 'utf8').digest('hex');

  it('derives an observational bundle from the exact call/result pair', () => {
    const call = callRow(OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE);
    const result = resultRow({ success: true, data: { card: 'a' } }, {
      kind: 'tool_result',
      settlement_origin: 'executed',
      result_content_sha256: observedSha,
      call_policy_sha256: call.context_policy.kind === 'tool_call' ? call.context_policy.template_sha256 : '',
      evidence: { kind: 'observational_query', observedSha256: observedSha },
    });
    expect(settledToolBundlePolicy(call, result)).toEqual({
      storage: 'durable',
      replacement: { kind: 'retain' },
      settledAudience: 'summarizer_only',
      evidence: { kind: 'observational_query', tool: 'get_card', arguments: { id: 'card-a' }, observed_sha256: observedSha },
    });
  });

  it('derives none evidence for failed or rejected settlements without parsing arguments', () => {
    const malformed = callRow(OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE);
    const embedded = JSON.parse(malformed.content) as { tool_calls: Array<{ function: { arguments: string } }> };
    embedded.tool_calls[0]!.function.arguments = '{';
    const malformedCall = { ...malformed, content: JSON.stringify(embedded) };
    const failed = resultRow({ success: false, error: 'agent protocol violation' }, {
      kind: 'tool_result',
      settlement_origin: 'rejected_before_execution',
      result_content_sha256: '0'.repeat(64),
      call_policy_sha256: malformedCall.context_policy.kind === 'tool_call' ? malformedCall.context_policy.template_sha256 : '',
      evidence: { kind: 'none' },
    });
    expect(settledToolBundlePolicy(malformedCall, failed)).toMatchObject({ evidence: { kind: 'none' } });
  });

  it('keeps mutation bundles primary-visible with none evidence', () => {
    const call = callRow(OPERATIONAL_RESULT_POLICY_TEMPLATE, 'write');
    const result = resultRow({ success: true }, {
      kind: 'tool_result',
      settlement_origin: 'executed',
      result_content_sha256: createHash('sha256').update(canonicalJson({ success: true }), 'utf8').digest('hex'),
      call_policy_sha256: call.context_policy.kind === 'tool_call' ? call.context_policy.template_sha256 : '',
      evidence: { kind: 'none' },
    });
    const policy = settledToolBundlePolicy({ ...call, tool: 'write' }, { ...result, tool: 'write' });
    expect(policy.settledAudience).toBe('primary_and_summarizer');
    expect(policy.evidence).toEqual({ kind: 'none' });
  });

  it('rejects result/call commitment mismatches and evidence-kind disagreements', () => {
    const call = callRow(OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE);
    const baseEvidence: RowContextPolicy = { kind: 'tool_result', settlement_origin: 'executed', result_content_sha256: observedSha, call_policy_sha256: call.context_policy.kind === 'tool_call' ? call.context_policy.template_sha256 : '', evidence: { kind: 'observational_query', observedSha256: observedSha } };
    expect(() => settledToolBundlePolicy(call, resultRow({ success: true }, { ...baseEvidence, call_policy_sha256: '0'.repeat(64) }))).toThrow(/does not commit to its call's policy template hash/);
    expect(() => settledToolBundlePolicy(call, resultRow({ success: true }, { ...baseEvidence, evidence: { kind: 'none' } }))).toThrow(/requires observational settled evidence/);
    expect(() => settledToolBundlePolicy(call, { ...resultRow({ success: true }, { ...baseEvidence, evidence: { kind: 'observational_query', observedSha256: observedSha } }), tool: 'read' })).toThrow(/does not name its call's tool/);
  });
});
