import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import {
  agentMessageSchema,
  canonicalJson,
  CONTENT_POLICY_RETRY_TEXT,
  contentPolicyRefusalProjectionText,
  DURABLE_PRIMARY_CONTENT_POLICY,
  MODEL_RECOVERY_NOTICE_TEXT,
  STRUCTURAL_ROW_POLICY,
  type AgentMessage,
  type ConversationSessionId,
  type SettledToolEvidence,
  type ToolResultPolicyTemplate,
} from '../../../../src/schemas/index.js';
import type { ProcessToolResult } from '../../../../src/contracts/operator-api-processes.js';
import {
  composeContextProjection,
  providerConversationFromComposedContext,
  type ComposedContextProjection,
  type EffectiveCompactedHistoryFacts,
} from '../../../../src/runtime/actors/context/composition-projector.js';
import { contextContentSha256, type ContextBlock } from '../../../../src/runtime/actors/context/context-blocks.js';
import { buildContentPolicyRefusalMessage } from '../../../../src/runtime/actors/content-policy-messages.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE } from '../../../../src/tools/invocation.js';
import { toolRowPolicies } from '../../../helpers/row-policy-fixtures.js';
import { settledSuccessBytes } from '../../../../src/tools/tool-result-settlement.js';

const SESSION: ConversationSessionId = 'agent:planner:project';
const INPUT_A = '11111111-1111-4111-8111-111111111111';
const INPUT_B = '22222222-2222-4222-8222-222222222222';
const TS = '2026-08-17T00:00:00.000Z';
const EVIDENCE_ONLY_LOCATOR_TEMPLATE: ToolResultPolicyTemplate = { storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'evidence_only', evidenceMode: 'canonical_locator' };

function row(partial: Omit<AgentMessage, 'session_id' | 'context_policy' | 'round_id' | 'message_index' | 'block_index' | 'timestamp'> & Partial<Pick<AgentMessage, 'context_policy' | 'round_id' | 'block_index'>>): AgentMessage {
  return { session_id: SESSION, round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: TS, context_policy: DURABLE_PRIMARY_CONTENT_POLICY, ...partial } as AgentMessage;
}

function callRow(inputId: string, callId: string, tool = 'get_card', template: ToolResultPolicyTemplate = OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, argumentsJson = '{"id":"card-a"}'): AgentMessage {
  return row({
    id: `${inputId}:tool-call:${callId}`,
    role: 'assistant',
    kind: 'tool_call',
    tool,
    tool_call_id: callId,
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: tool, arguments: argumentsJson } }] }),
    context_policy: toolRowPolicies({ content: '', template }).call,
  });
}

function resultRow(inputId: string, callId: string, tool: string, content: string, template: ToolResultPolicyTemplate, evidence?: SettledToolEvidence): AgentMessage {
  return row({
    id: `${inputId}:tool-result:${callId}`,
    role: 'tool',
    kind: 'tool_result',
    tool,
    tool_call_id: callId,
    content,
    context_policy: toolRowPolicies({ content, template, evidence }).result,
  });
}

function dynamicBlock(id: string, overrides: Partial<Omit<ContextBlock, 'id'>> = {}): ContextBlock {
  return { id, role: 'user', content: `content:${id}`, storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, ...overrides };
}

const historyFacts = (partial: Omit<EffectiveCompactedHistoryFacts, 'historyMessageId' | 'historyTimestamp' | 'protectedPrompts'>): EffectiveCompactedHistoryFacts =>
  ({ historyMessageId: 'genesis-1:compacted-history', historyTimestamp: '2026-08-17T00:00:00.000Z', protectedPrompts: [], ...partial });

const compose = (uncoveredRows: readonly AgentMessage[], args: { effectiveHistory?: EffectiveCompactedHistoryFacts | null; dynamicBlocks?: readonly ContextBlock[] } = {}): ComposedContextProjection =>
  composeContextProjection({ sourceSessionId: SESSION, effectiveHistory: args.effectiveHistory ?? null, dynamicBlocks: args.dynamicBlocks ?? [], uncoveredRows });

const canonicalRows = (composed: ComposedContextProjection): readonly AgentMessage[] =>
  composed.primary.flatMap((entry) => (entry.origin === 'canonical' ? [entry.row] : []));

const recoveryRow = (inputId: string): AgentMessage =>
  row({ id: `${inputId}:model-recovered`, role: 'system', kind: 'model_recovered', content: MODEL_RECOVERY_NOTICE_TEXT, context_policy: STRUCTURAL_ROW_POLICY.model_recovery_notice, round_id: `r-pre-${'1'.repeat(32)}`, block_index: 1 });

const refusalRow = (inputId: string): AgentMessage =>
  buildContentPolicyRefusalMessage({ sessionId: SESSION, sourceInputId: inputId, candidate: { provider: 'test', account: null, model: 'model' }, providerResponse: `RAW-REFUSAL-${inputId}` });

const PROCESS_ID = 'proc-0123456789ab';

function processData(overrides: Partial<ProcessToolResult> = {}, cardId?: string): ProcessToolResult {
  const directory = cardId ? `cards/${cardId}/processes/${PROCESS_ID}` : `processes/${PROCESS_ID}`;
  return {
    process_id: PROCESS_ID,
    exit_code: 0,
    status: 'exited',
    stdout: 'output',
    stderr: 'warning',
    stdout_complete: true,
    stderr_complete: false,
    stdout_url: `work:///${directory}/stdout.log`,
    stderr_url: `work:///${directory}/stderr.log`,
    stdout_bytes: 6,
    stderr_bytes: 7,
    ...overrides,
  };
}

function processRows(tool: 'run_command' | 'wait_process' | 'kill_process', data: unknown, content = canonicalJson({ success: true, data })): readonly [AgentMessage, AgentMessage] {
  const call = callRow(INPUT_A, `call-${tool}`, tool, OPERATIONAL_RESULT_POLICY_TEMPLATE, '{}');
  const result = resultRow(INPUT_A, `call-${tool}`, tool, content, OPERATIONAL_RESULT_POLICY_TEMPLATE);
  return [agentMessageSchema.parse(call), agentMessageSchema.parse(result)];
}

describe('composition projector selection pass', () => {
  it('derives both projections from one selection with dynamic blocks before canonical rows', () => {
    const resultContent = JSON.stringify({ success: true, data: { card: 'a' } });
    const observed = createHash('sha256').update(resultContent, 'utf8').digest('hex');
    const rows = [
      row({ id: 'u1', role: 'user', kind: 'text', content: 'question' }),
      callRow(INPUT_A, 'call-1'),
      resultRow(INPUT_A, 'call-1', 'get_card', resultContent, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, { kind: 'observational_query', observedSha256: observed }),
    ];
    const composed = compose(rows, { dynamicBlocks: [dynamicBlock('tree')] });
    expect(composed.primary.map((entry) => entry.origin)).toEqual(['dynamic', 'canonical', 'canonical', 'canonical']);
    expect(composed.primary[0]).toMatchObject({ origin: 'dynamic', block: { id: 'tree' } });
    expect(composed.summarizer).toEqual([
      { kind: 'message', sourceId: 'u1', role: 'user', content: 'question', semantic: 'direct', responsesPrivateMessageId: null },
      { kind: 'settled_tool_bundle', identity: { session_id: SESSION, source_input_id: INPUT_A, tool_call_id: 'call-1' }, toolName: 'get_card', callArguments: '{"id":"card-a"}', resultContent, policy: { storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'summarizer_only', evidence: { kind: 'observational_query', tool: 'get_card', arguments: { id: 'card-a' }, observed_sha256: observed } }, responsesPrivateMessageId: null },
    ]);
    expect(providerConversationFromComposedContext(compose(rows)).messages.map((row) => row.kind === 'synthetic_context' ? row.origin : row.id)).toEqual(['context_boundary', 'u1', `${INPUT_A}:tool-call:call-1`, `${INPUT_A}:tool-result:call-1`]);
  });

  it('drops superseded snapshots after verifying every represented-content hash', () => {
    const stale = dynamicBlock('tree-1', { content: 'tree-v1', replacement: { kind: 'latest_snapshot', key: 'analyst.project_tree', contentSha256: contextContentSha256('tree-v1') } });
    const latest = dynamicBlock('tree-2', { content: 'tree-v2', replacement: { kind: 'latest_snapshot', key: 'analyst.project_tree', contentSha256: contextContentSha256('tree-v2') } });
    const composed = compose([], { dynamicBlocks: [stale, latest] });
    expect(composed.primary).toHaveLength(1);
    expect(composed.primary[0]).toMatchObject({ origin: 'dynamic', block: { id: 'tree-2' } });
    const mismatch = dynamicBlock('tree-3', { content: 'tree-v3', replacement: { kind: 'latest_snapshot', key: 'analyst.project_tree', contentSha256: contextContentSha256('other') } });
    expect(() => compose([], { dynamicBlocks: [mismatch] })).toThrow(/replacement hash does not commit/);
  });

  it('reuses the exact frozen prepared block after its source state changes', () => {
    let currentBrief = 'brief prepared at activation';
    const prepared = Object.freeze(dynamicBlock('card-activation:project', { role: 'system', content: currentBrief }));
    currentBrief = 'new card state that must wait for the next activation';

    const first = providerConversationFromComposedContext(compose([], { dynamicBlocks: [prepared] }));
    const continuation = providerConversationFromComposedContext(compose([row({ id: 'u2', role: 'user', kind: 'text', content: 'continue' })], { dynamicBlocks: [prepared] }));

    expect(first.messages[0]).toMatchObject({ kind: 'synthetic_context', block_identity: prepared.id, content: 'brief prepared at activation' });
    expect(continuation.messages[0]).toEqual(first.messages[0]);
    expect(continuation.messages[1]).toMatchObject({ kind: 'synthetic_context', origin: 'context_boundary' });
    expect(JSON.stringify(continuation)).not.toContain(currentBrief);
  });

  it('adds one request-only context boundary only before non-dynamic context and labels only the request summary', () => {
    const card = dynamicBlock('card-activation:project', { role: 'system', content: 'CARD' });
    const node = dynamicBlock('node-activation:project:work', { role: 'system', content: "Current workflow node 'work':\n\nCURRENT-NODE" });
    const oldNode = row({ id: 'old-node-looking-row', role: 'user', kind: 'text', content: 'CURRENT-NODE' });
    const ownerRequirement = row({ id: 'owner-requirement', role: 'user', kind: 'text', content: 'Still-applicable owner requirement' });
    const effectiveHistory = historyFacts({ summaryText: 'Draft proposal, not approval', requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null } });

    const provider = providerConversationFromComposedContext(compose([oldNode, ownerRequirement], { effectiveHistory, dynamicBlocks: [card, node] }));
    expect(provider.messages.map((item) => item.kind === 'synthetic_context' ? item.origin : item.id)).toEqual([
      'dynamic', 'dynamic', 'context_boundary', 'history_summary', 'old-node-looking-row', 'owner-requirement',
    ]);
    expect(provider.messages.filter((item) => item.kind === 'synthetic_context' && item.origin === 'context_boundary')).toHaveLength(1);
    expect(provider.messages[3]).toMatchObject({ kind: 'synthetic_context', origin: 'history_summary', content: 'Historical summary:\nDraft proposal, not approval' });
    expect(provider.messages[4]).toMatchObject({ kind: 'text', content: 'CURRENT-NODE' });
    expect(provider.messages[5]).toMatchObject({ kind: 'text', content: 'Still-applicable owner requirement' });
    expect(effectiveHistory.summaryText).toBe('Draft proposal, not approval');
    expect(compose([], { dynamicBlocks: [card, node] }).primary).toHaveLength(2);
    expect(providerConversationFromComposedContext(compose([], { dynamicBlocks: [card, node] })).messages.every((item) => item.kind !== 'synthetic_context' || item.origin !== 'context_boundary')).toBe(true);
  });

  it('gives Analyst conditional historical framing without fabricating a workflow node', () => {
    const orientation = dynamicBlock('analyst-submission:one', { role: 'system', content: 'Prepared project orientation' });
    const provider = providerConversationFromComposedContext(compose([
      row({ id: 'analyst-question', role: 'user', kind: 'text', content: 'Investigate this' }),
    ], { dynamicBlocks: [orientation] }));

    expect(provider.messages.map((item) => item.kind === 'synthetic_context' ? item.origin : item.id)).toEqual(['dynamic', 'context_boundary', 'analyst-question']);
    expect(provider.messages[1]).toMatchObject({ kind: 'synthetic_context', role: 'system', origin: 'context_boundary' });
    expect(provider.messages[1].content).not.toHaveLength(0);
    expect(JSON.stringify(provider.messages)).not.toContain('node-activation:');
  });

  it('omits activation boundaries and provider failures from both projections', () => {
    const composed = compose([
      row({ id: 'act', role: 'system', kind: 'activity', content: '{"event":"activation_open"}', context_policy: STRUCTURAL_ROW_POLICY.activation_boundary }),
      row({ id: 'issue', role: 'assistant', kind: 'model_issue', content: 'provider blew up', context_policy: STRUCTURAL_ROW_POLICY.provider_failure }),
      row({ id: 't1', role: 'user', kind: 'text', content: 'hello' }),
    ]);
    expect(canonicalRows(composed).map((row) => row.id)).toEqual(['t1']);
    expect(composed.summarizer).toEqual([{ kind: 'message', sourceId: 't1', role: 'user', content: 'hello', semantic: 'direct', responsesPrivateMessageId: null }]);
  });

  it('routes summarizer-only and evidence-only content rows by audience', () => {
    const summarizerOnly = { kind: 'content' as const, storage: 'durable' as const, replacement: { kind: 'retain' as const }, audience: 'summarizer_only' as const, evidence: { kind: 'none' as const }, compactable: true };
    const evidenceOnly = { kind: 'content' as const, storage: 'durable' as const, replacement: { kind: 'retain' as const }, audience: 'evidence_only' as const, evidence: { kind: 'canonical_locator' as const, locator: 'card://project/version/1', sha256: 'b'.repeat(64) }, compactable: true };
    const composed = compose([
      row({ id: 'so', role: 'user', kind: 'text', content: 'hidden from primary? no', context_policy: summarizerOnly }),
      row({ id: 'eo', role: 'user', kind: 'text', content: 'body never summarized', context_policy: evidenceOnly }),
    ]);
    expect(canonicalRows(composed).map((row) => row.id)).toEqual(['so', 'eo']);
    expect(composed.summarizer).toEqual([
      { kind: 'message', sourceId: 'so', role: 'user', content: 'hidden from primary? no', semantic: 'direct', responsesPrivateMessageId: null },
      { kind: 'evidence', sourceId: 'eo', evidence: { kind: 'canonical_locator', locator: 'card://project/version/1', sha256: 'b'.repeat(64) } },
    ]);
  });
});

describe('bounded repeated-event rule', () => {
  it('projects only the newest uncovered recovery and refusal, each exactly once, without mutating genesis', () => {
    const refusalA = refusalRow(INPUT_A);
    const refusalB = refusalRow(INPUT_B);
    const effectiveHistory: EffectiveCompactedHistoryFacts = historyFacts({
      summaryText: 'prior prose',
      requiredModelFacts: {
        latestRecovery: { sourceMessageId: `${INPUT_A}:model-recovered`, activationInputId: INPUT_A },
        latestContentPolicyRefusal: { markerId: refusalA.id, activationInputId: INPUT_A },
      },
    });
    const composed = compose([recoveryRow(INPUT_A), recoveryRow(INPUT_B), refusalA, refusalB], { effectiveHistory });
    const rows = canonicalRows(composed);
    expect(rows.filter((row) => row.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
    expect(composed.recoveryNoticeMessageId).toBe(`${INPUT_B}:model-recovered`);
    expect(composed.refusalNoticeMessageId).toBe(refusalB.id);
    expect(rows.filter((row) => row.content === contentPolicyRefusalProjectionText(SESSION, refusalB.id))).toHaveLength(1);
    expect(JSON.stringify(composed)).not.toContain('RAW-REFUSAL');
    expect(effectiveHistory.requiredModelFacts.latestRecovery!.sourceMessageId).toBe(`${INPUT_A}:model-recovered`);
    expect(composed.summarizer.filter((item) => item.kind === 'message' && item.semantic === 'recovery_notice')).toHaveLength(1);
    expect(composed.summarizer.filter((item) => item.kind === 'message' && item.semantic === 'refusal_notice')).toHaveLength(1);
    expect(composed.summarizer[0]).toEqual({ kind: 'inherited_summary', content: 'prior prose' });
    expect(composed.primary[0]).toMatchObject({ origin: 'history_summary', content: 'prior prose', messageId: 'genesis-1:compacted-history' });
  });

  it('synthesizes the exact notices from inherited slots when no newer uncovered occurrence exists', () => {
    const recovery = { sourceMessageId: `${INPUT_A}:model-recovered`, activationInputId: INPUT_A };
    const markerId = refusalRow(INPUT_A).id;
    const effectiveHistory: EffectiveCompactedHistoryFacts = historyFacts({
      summaryText: 'accumulated',
      requiredModelFacts: { latestRecovery: recovery, latestContentPolicyRefusal: { markerId, activationInputId: INPUT_A } },
    });
    const composed = compose([], { effectiveHistory });
    const rows = canonicalRows(composed);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: recovery.sourceMessageId, role: 'system', kind: 'text', content: MODEL_RECOVERY_NOTICE_TEXT });
    expect(rows[1]).toMatchObject({ id: markerId, role: 'user', kind: 'text', content: contentPolicyRefusalProjectionText(SESSION, markerId) });
    expect(composed.recoveryNoticeMessageId).toBe(recovery.sourceMessageId);
    expect(composed.refusalNoticeMessageId).toBe(markerId);
  });

  it('rejects an inherited recovery slot that does not match its activation identity', () => {
    const effectiveHistory: EffectiveCompactedHistoryFacts = historyFacts({ summaryText: 'x', requiredModelFacts: { latestRecovery: { sourceMessageId: 'not-the-identity', activationInputId: INPUT_A }, latestContentPolicyRefusal: null } });
    expect(() => compose([], { effectiveHistory })).toThrow(/does not match its activation identity/);
  });

  it('emits the exact code-owned retry text and never a raw refusal marker body', () => {
    const retry = row({ id: `${INPUT_A}:content-policy-retry`, role: 'user', kind: 'content_policy_retry', content: CONTENT_POLICY_RETRY_TEXT });
    const refusal = refusalRow(INPUT_A);
    const composed = compose([retry, refusal]);
    const rows = canonicalRows(composed);
    expect(rows.filter((row) => row.content === CONTENT_POLICY_RETRY_TEXT)).toHaveLength(1);
    expect(rows.find((row) => row.id === retry.id)).toMatchObject({ role: 'user', kind: 'text' });
    expect(JSON.stringify(composed)).not.toContain('RAW-REFUSAL');
    expect(composed.summarizer).toEqual(expect.arrayContaining([
      { kind: 'message', sourceId: retry.id, role: 'user', content: CONTENT_POLICY_RETRY_TEXT, semantic: 'retry_notice', responsesPrivateMessageId: null },
      { kind: 'message', sourceId: refusal.id, role: 'user', content: contentPolicyRefusalProjectionText(SESSION, refusal.id), semantic: 'refusal_notice', responsesPrivateMessageId: null },
    ]));
  });
});

describe('tool bundle indivisibility', () => {
  it('projects one indivisible settled bundle and keeps an unmatched final call visible but uncoverable', () => {
    const resultContent = JSON.stringify({ success: true, data: { card: 'a' } });
    const observed = createHash('sha256').update(resultContent, 'utf8').digest('hex');
    const rows = [
      callRow(INPUT_A, 'call-1'),
      resultRow(INPUT_A, 'call-1', 'get_card', resultContent, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, { kind: 'observational_query', observedSha256: observed }),
      callRow(INPUT_A, 'call-2'),
    ];
    const composed = compose(rows);
    expect(canonicalRows(composed).map((row) => row.kind)).toEqual(['tool_call', 'tool_result', 'tool_call']);
    expect(composed.summarizer).toEqual([
      {
        kind: 'settled_tool_bundle',
        identity: { session_id: SESSION, source_input_id: INPUT_A, tool_call_id: 'call-1' },
        toolName: 'get_card',
        callArguments: '{"id":"card-a"}',
        resultContent,
        policy: { storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'summarizer_only', evidence: { kind: 'observational_query', tool: 'get_card', arguments: { id: 'card-a' }, observed_sha256: observed } },
        responsesPrivateMessageId: null,
      },
    ]);
  });

  it('emits only the bounded typed evidence representation for evidence-only bundles', () => {
    const resultContent = JSON.stringify({ success: true, data: {} });
    const call = callRow(INPUT_A, 'call-9', 'get_card_version', EVIDENCE_ONLY_LOCATOR_TEMPLATE);
    const result = resultRow(INPUT_A, 'call-9', 'get_card_version', resultContent, EVIDENCE_ONLY_LOCATOR_TEMPLATE, { kind: 'canonical_locator', locator: 'card://project/version/3#entry=e1', sha256: 'a'.repeat(64) });
    const composed = compose([call, result]);
    expect(canonicalRows(composed)).toHaveLength(2);
    expect(composed.summarizer).toEqual([{ kind: 'evidence', sourceId: call.id, evidence: { kind: 'canonical_locator', locator: 'card://project/version/3#entry=e1', sha256: 'a'.repeat(64) } }]);
  });

  it('fails fast on results without their call and on repeated composite identities', () => {
    const resultContent = JSON.stringify({ success: true });
    const orphan = resultRow(INPUT_A, 'call-x', 'get_card', resultContent, OPERATIONAL_RESULT_POLICY_TEMPLATE);
    expect(() => compose([orphan])).toThrow(/settles no prior unmatched tool call/);
    const call = callRow(INPUT_A, 'call-1', 'get_card', OPERATIONAL_RESULT_POLICY_TEMPLATE);
    expect(() => compose([call, call])).toThrow(/repeats the composite identity/);
  });
});

describe('primary process-result projection', () => {
  it.each(['run_command', 'wait_process', 'kill_process'] as const)('omits each eligible URL independently for %s without changing durable or summarizer bytes', (tool) => {
    const data = processData();
    const equivalentDataJson = JSON.stringify(data).replace('"output"', '"\\u006futput"');
    const sourceContent = ` { "data" : ${equivalentDataJson}, "success" : true } `;
    const rows = processRows(tool, data, sourceContent);
    const original = structuredClone(rows[1]);
    const composed = compose(rows);
    const provider = providerConversationFromComposedContext(composed);
    const copied = provider.messages.find((message) => message.kind === 'tool_result');
    if (!copied || copied.kind === 'synthetic_context') throw new Error('Missing projected process result.');
    const parsed = JSON.parse(copied.content) as { success: true; data: Record<string, unknown> };

    expect(parsed.data).not.toHaveProperty('stdout_url');
    expect(parsed.data.stderr_url).toBe(data.stderr_url);
    expect(copied.content).toBe(canonicalJson(parsed));
    expect(copied.context_policy).toEqual({ ...rows[1].context_policy, result_content_sha256: contextContentSha256(copied.content) });
    expect(agentMessageSchema.parse(copied)).toEqual(copied);
    expect(rows[1]).toEqual(original);
    expect(composed.summarizer).toContainEqual(expect.objectContaining({ kind: 'settled_tool_bundle', resultContent: sourceContent }));
  });

  it('retains both URLs for a running result and still canonicalizes the provider copy', () => {
    const data = processData({ status: 'running', exit_code: null, stdout_complete: true, stderr_complete: true });
    const sourceContent = `${' '.repeat(33_000)}${JSON.stringify({ data, success: true })}`;
    const rows = processRows('wait_process', data, sourceContent);
    const composed = compose(rows);
    const copied = providerConversationFromComposedContext(composed).messages.find((message): message is AgentMessage => message.kind === 'tool_result')!;

    expect(copied.content).toBe(settledSuccessBytes(data));
    expect(Buffer.byteLength(copied.content, 'utf8')).toBeLessThan(32_768);
    expect(JSON.parse(copied.content).data).toEqual(data);
    expect(rows[1].content).toBe(sourceContent);
    expect(composed.summarizer).toContainEqual(expect.objectContaining({ resultContent: sourceContent }));
  });

  it.each(['failed', 'killed'] as const)('treats %s as done for independently complete stream omission', (status) => {
    const data = processData({ status, stderr_complete: true });
    const rows = processRows('wait_process', data);
    const copied = providerConversationFromComposedContext(compose(rows)).messages.find((message) => message.kind === 'tool_result')!;
    const projected = (JSON.parse(copied.content) as { data: Record<string, unknown> }).data;
    expect(projected).not.toHaveProperty('stdout_url');
    expect(projected).not.toHaveProperty('stderr_url');
  });

  it('omits both eligible URLs from padded retained JSON while preserving prepared and retained instruction context', () => {
    const data = processData({ stderr_complete: true });
    const sourceContent = `\n${' '.repeat(33_000)}{ "data": ${JSON.stringify(data)}, "success": true }`;
    const rows = processRows('run_command', data, sourceContent);
    const retained = agentMessageSchema.parse(row({ id: 'retained', role: 'user', kind: 'text', content: 'EXACT RETAINED INSTRUCTION' }));
    const prepared = Object.freeze(dynamicBlock('prepared', { role: 'system', content: 'EXACT PREPARED PREFIX' }));
    const effectiveHistory: EffectiveCompactedHistoryFacts = {
      ...historyFacts({ summaryText: 'prior', requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null } }),
      protectedPrompts: [{ source: { segmentVersion: 2, rowIndex: 7 }, message: retained }],
    };
    const composed = compose(rows, { effectiveHistory, dynamicBlocks: [prepared] });
    const provider = providerConversationFromComposedContext(composed);
    const copied = provider.messages.find((message): message is AgentMessage => message.kind === 'tool_result')!;
    const copiedData = (JSON.parse(copied.content) as { data: Record<string, unknown> }).data;
    const expectedData: Record<string, unknown> = { ...data };
    delete expectedData.stdout_url;
    delete expectedData.stderr_url;

    expect(copiedData).not.toHaveProperty('stdout_url');
    expect(copiedData).not.toHaveProperty('stderr_url');
    expect(copied.content).toBe(canonicalJson({ success: true, data: expectedData }));
    expect(Buffer.byteLength(copied.content, 'utf8')).toBeLessThan(Buffer.byteLength(settledSuccessBytes(data), 'utf8'));
    expect(provider.messages.map((message) => message.kind === 'synthetic_context' ? [message.origin, message.content, message.block_identity] : message.id)).toEqual([
      ['dynamic', prepared.content, prepared.id],
      ['context_boundary', expect.any(String), `${SESSION}:context-boundary`],
      ['history_summary', 'Historical summary:\nprior', 'genesis-1:compacted-history'],
      ['retained_instruction', retained.content, '2:7:retained'],
      rows[0].id,
      rows[1].id,
    ]);
    expect(rows[1].content).toBe(sourceContent);
    expect(composed.summarizer).toContainEqual(expect.objectContaining({ resultContent: sourceContent }));
    const invalidSourceHash = { ...rows[1], context_policy: { ...rows[1].context_policy, result_content_sha256: '0'.repeat(64) } };
    expect(agentMessageSchema.safeParse(invalidSourceHash).success).toBe(false);
  });

  it('passes failed process results and non-process results through unchanged', () => {
    const failed = canonicalJson({ success: false, error: 'command failed' });
    const process = processRows('kill_process', undefined, failed);
    const otherContent = canonicalJson({ success: true, data: { value: 1 } });
    const other = [
      callRow(INPUT_B, 'call-other', 'get_card', OPERATIONAL_RESULT_POLICY_TEMPLATE, '{}'),
      resultRow(INPUT_B, 'call-other', 'get_card', otherContent, OPERATIONAL_RESULT_POLICY_TEMPLATE),
    ] as const;
    const rows = [...process, ...other];
    const projected = providerConversationFromComposedContext(compose(rows));
    expect(projected.messages.filter((message): message is AgentMessage => message.kind === 'tool_result')).toEqual([rows[1], rows[3]]);
  });

  it.each([
    ['oversized stdout', () => processData({ stdout: 'x'.repeat(2_049) })],
    ['oversized stdout lines', () => processData({ stdout: 'x\n'.repeat(31) })],
    ['oversized stderr', () => processData({ stderr: 'x'.repeat(2_049) })],
    ['oversized stderr lines', () => processData({ stderr: 'x\n'.repeat(31) })],
    ['unstable head', () => processData({ stdout: 'token=synthetic-secret-value' })],
    ['missing URL', () => { const { stdout_url: _removed, ...data } = processData({ stderr_complete: true }); return data; }],
    ['mismatched URL', () => processData({ stderr_complete: true, stdout_url: 'work:///processes/proc-aaaaaaaaaaaa/stdout.log' })],
    ['inconsistent URL directories', () => processData({ stderr_complete: true, stderr_url: `work:///cards/card-a/processes/${PROCESS_ID}/stderr.log` })],
    ['noncanonical URL', () => processData({ stderr_complete: true, stdout_url: `work:///processes/${PROCESS_ID}/stdout.log?raw=1` })],
    ['oversized fixed metadata', () => processData({ stderr_complete: true }, `card-${'a'.repeat(40_000)}`)],
  ])('rejects %s at direct primary use without mutating the canonical row', (_label, makeData) => {
    const rows = processRows('run_command', makeData());
    const original = structuredClone(rows[1]);
    const composed = compose(rows);
    expect(() => providerConversationFromComposedContext(composed)).toThrow();
    expect(rows[1]).toEqual(original);
  });

  it('rejects malformed process ToolResult JSON at direct use', () => {
    const call = callRow(INPUT_A, 'call-malformed', 'run_command', OPERATIONAL_RESULT_POLICY_TEMPLATE, '{}');
    const malformed = resultRow(INPUT_A, 'call-malformed', 'run_command', '{not-json', OPERATIONAL_RESULT_POLICY_TEMPLATE);
    expect(() => providerConversationFromComposedContext(compose([call, malformed]))).toThrow(SyntaxError);
  });

  it('strictly rejects extra successful ToolResult envelope members', () => {
    const data = processData();
    const content = canonicalJson({ success: true, data, extra: true });
    expect(() => providerConversationFromComposedContext(compose(processRows('run_command', data, content)))).toThrow();
  });
});

describe('responses private pairs', () => {
  it('keeps the exact private/visible pair in the primary projection and never summarizes the private row', () => {
    const output = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' }];
    const privateRow = row({
      id: `${INPUT_A}:provider-private:openai-responses`,
      role: 'system',
      kind: 'provider_private',
      content: JSON.stringify({ transport: 'openai-responses', source_input_id: INPUT_A, projection_message_id: `${INPUT_A}:tool-call:call-1`, provider: 'openai', model: 'gpt-5.6', output }),
      context_policy: STRUCTURAL_ROW_POLICY.responses_private,
    });
    const visible = { ...callRow(INPUT_A, 'call-1', 'read', UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE, '{}'), provider_projection: { kind: 'openai_responses' as const, source_input_id: INPUT_A, private_message_id: privateRow.id, projection_kind: 'assistant_tool_call' as const } };
    const composed = compose([privateRow, visible]);
    expect(canonicalRows(composed).map((row) => row.id)).toEqual([privateRow.id, visible.id]);
    expect(composed.summarizer).toEqual([]);
  });
});
