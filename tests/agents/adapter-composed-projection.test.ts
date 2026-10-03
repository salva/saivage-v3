import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import { composeContextProjection, providerConversationFromComposedContext } from '../../src/runtime/actors/context/composition-projector.js';
import { buildContentPolicyRefusalMessage } from '../../src/runtime/actors/content-policy-messages.js';
import { canonicalJson, DURABLE_PRIMARY_CONTENT_POLICY, MODEL_RECOVERY_NOTICE_TEXT, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { LlmCompleteOptions } from '../../src/contracts/index.js';
import type { ProviderConversationProjection } from '../../src/contracts/index.js';
import type { ContextBlock } from '../../src/contracts/index.js';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { validateConversation } from '../../src/contracts/conversation-validation.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';

const SESSION: ConversationSessionId = 'agent:planner:project';
const INPUT_A = '11111111-1111-4111-8111-111111111111';
const INPUT_B = '22222222-2222-4222-8222-222222222222';
const TS = '2026-08-17T00:00:00.000Z';
const CANDIDATE: Candidate = { provider: 'openai', account: null, model: 'gpt-5.6' };
const OPTS: LlmCompleteOptions = { inputId: 'ordering-check', temperature: 0, max_tokens: 512, contract_id: 'c', contractName: 'contract', terminalToolOffered: [], tools: [], tool_choice: 'auto' };
const capabilities = (transportProtocol: 'openai-chat-completions' | 'openai-responses' | 'openai-codex-backend') => ({ transportProtocol, toolsMode: 'native' as const, exclusiveToolChoiceSupport: 'native' as const, quirks: [] });
const requestBody = (transportProtocol: 'openai-chat-completions' | 'openai-responses' | 'openai-codex-backend', providerConversation: ProviderConversationProjection) => selectLlmProtocolAdapter(transportProtocol).buildRequestBody({ candidate: CANDIDATE, systemPrompt: 'prefix-instructions', providerConversation, options: OPTS, capabilities: capabilities(transportProtocol) });

function recoveryRow(inputId: string): AgentMessage {
  return { id: `${inputId}:model-recovered`, session_id: SESSION, role: 'system', kind: 'model_recovered', content: MODEL_RECOVERY_NOTICE_TEXT, context_policy: { kind: 'structural', behavior: 'model_recovery_notice' }, round_id: `r-pre-${'1'.repeat(32)}`, message_index: 0, block_index: 1, timestamp: TS };
}

function userRow(id: string, content: string): AgentMessage {
  return { id, session_id: SESSION, role: 'user', kind: 'text', content, context_policy: DURABLE_PRIMARY_CONTENT_POLICY, round_id: `r-user-${'2'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: TS };
}

describe('protocol adapters consume the composed projection', () => {
  it.each(['openai-chat-completions', 'openai-responses', 'openai-codex-backend'] as const)('preserves sequential exchanges with repeated provider IDs and private reasoning in %s', (protocol) => {
    const callId = 'repeated-provider-id';
    const rows: AgentMessage[] = [];
    const privateOutput = [{ type: 'reasoning', encrypted_content: 'opaque-reasoning' }, { type: 'function_call', call_id: callId, name: 'read', arguments: '{"path":"second"}' }];
    for (const [index, inputId] of [INPUT_A, INPUT_B].entries()) {
      const content = JSON.stringify({ success: true, data: { content: index === 0 ? 'first result' : 'second result' } });
      const policies = toolRowPolicies({ content });
      const common = { session_id: SESSION, round_id: `r-assistant-${String(index + 1).repeat(32)}`, message_index: 1, block_index: 0, timestamp: TS };
      const call: AgentMessage = { ...common, id: `${inputId}:tool-call:${callId}`, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: callId, context_policy: policies.call, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: index === 0 ? 'first' : 'second' }) } }] }) };
      if (index === 1) {
        const privateId = `${inputId}:provider-private:openai-responses`;
        call.provider_projection = { kind: 'openai_responses', source_input_id: inputId, private_message_id: privateId, projection_kind: 'assistant_tool_call' };
        rows.push({ ...common, id: privateId, role: 'system', kind: 'provider_private', context_policy: { kind: 'structural', behavior: 'responses_private' }, content: JSON.stringify({ transport: 'openai-responses', producer_account_id: responsesProducerAccountId(CANDIDATE), source_input_id: inputId, projection_message_id: call.id, provider: 'openai', model: 'gpt-5.6', output: privateOutput }) });
      }
      rows.push(call, { ...common, message_index: 2, id: `${inputId}:tool-result:${callId}`, role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: callId, context_policy: policies.result, content });
    }
    const conversation = validateConversation(SESSION, rows);
    const projected = providerConversationProjection(conversation, [{ id: 'current-context', role: 'system', content: 'synthetic context', storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } }]);
    expect(projected.messages.some((row) => row.kind === 'synthetic_context')).toBe(true);
    const body = requestBody(protocol, projected);
    if (protocol === 'openai-chat-completions') {
      const messages = body.messages as Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string; content: string }>;
      const exchanges = messages.filter((row) => row.tool_calls || row.role === 'tool');
      expect(exchanges.map((row) => row.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
      expect(exchanges.map((row) => row.tool_calls?.[0]?.id ?? row.tool_call_id)).toEqual(Array(4).fill(callId));
      expect(exchanges[1]!.content).toContain('first result');
      expect(exchanges[3]!.content).toContain('second result');
    } else {
      const input = body.input as Array<Record<string, unknown>>;
      const exchanges = input.filter((row) => row.type === 'function_call' || row.type === 'function_call_output');
      expect(exchanges.map((row) => row.type)).toEqual(['function_call', 'function_call_output', 'function_call', 'function_call_output']);
      expect(exchanges.map((row) => row.call_id)).toEqual(Array(4).fill(callId));
      expect(exchanges[1]!.output).toContain('first result');
      expect(exchanges[3]!.output).toContain('second result');
      if (protocol === 'openai-responses') expect(input.filter((row) => row.type === 'reasoning')).toEqual([privateOutput[0]]);
    }
  });

  const refusalA = buildContentPolicyRefusalMessage({ sessionId: SESSION, sourceInputId: INPUT_A, candidate: { provider: 'openai', account: null, model: 'gpt-5.6' }, providerResponse: 'RAW-A' });
  const refusalB = buildContentPolicyRefusalMessage({ sessionId: SESSION, sourceInputId: INPUT_B, candidate: { provider: 'openai', account: null, model: 'gpt-5.6' }, providerResponse: 'RAW-B' });
  const composed = composeContextProjection({
    sourceSessionId: SESSION,
    effectiveHistory: { summaryText: 'prior summary', historyMessageId: 'history-block', historyTimestamp: TS, requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null }, protectedPrompts: [] },
    dynamicBlocks: [
      { id: 'prepared-card', role: 'system', content: '{"brief":"FULL-BRIEF"}', storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } } satisfies ContextBlock,
      { id: 'prepared-node', role: 'system', content: "Current workflow node 'work':\n\nEXACT-COMPILED-NODE", storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } } satisfies ContextBlock,
    ],
    uncoveredRows: [recoveryRow(INPUT_A), recoveryRow(INPUT_B), userRow('u1', 'first question'), refusalA, refusalB],
  });
  const providerConversation = providerConversationFromComposedContext(composed);
  const identities = providerConversation.messages.map((item) => item.kind === 'synthetic_context' ? item.block_identity : item.id);
  const boundary = providerConversation.messages.find((item) => item.kind === 'synthetic_context' && item.origin === 'context_boundary');
  const summary = providerConversation.messages.find((item) => item.kind === 'synthetic_context' && item.origin === 'history_summary');
  if (!boundary || !summary) throw new Error('Missing composed boundary or history summary.');

  it('projects each repeated recovery and refusal semantic exactly once before adapter mapping', () => {
    expect(identities).toEqual(['prepared-card', 'prepared-node', `${SESSION}:context-boundary`, 'history-block', `${INPUT_B}:model-recovered`, refusalB.id, 'u1']);
  });

  it('Chat maps the prefix first and the projected system and user notices normally', () => {
    const chat = requestBody('openai-chat-completions', providerConversation) as unknown as { messages: Array<{ role: string; content: string }> };
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'prefix-instructions' });
    expect(chat.messages.slice(1).map((message) => message.role)).toEqual(['system', 'system', 'system', 'system', 'system', 'user', 'user']);
    expect(chat.messages.filter((message) => message.content === '{"brief":"FULL-BRIEF"}')).toHaveLength(1);
    expect(chat.messages.filter((message) => message.content === "Current workflow node 'work':\n\nEXACT-COMPILED-NODE")).toHaveLength(1);
    expect(chat.messages.findIndex((message) => message.content === boundary.content)).toBe(3);
    expect(chat.messages.findIndex((message) => message.content === summary.content)).toBe(4);
    expect(chat.messages.filter((message) => message.content === 'prefix-instructions')).toHaveLength(1);
    expect(chat.messages.filter((message) => message.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
  });

  it('Codex keeps static instructions singular and maps ordered synthetic system context into input', () => {
    const body = requestBody('openai-codex-backend', providerConversation) as unknown as { instructions: string; input: Array<{ role?: string; content?: unknown }> };
    expect(body.instructions).toBe('prefix-instructions');
    expect(body.input.slice(0, 4).map((item) => item.role)).toEqual(['system', 'system', 'system', 'system']);
    expect(JSON.stringify(body.input).match(/FULL-BRIEF/g)).toHaveLength(1);
    expect(JSON.stringify(body.input).match(/EXACT-COMPILED-NODE/g)).toHaveLength(1);
    expect(JSON.stringify(body.input).match(new RegExp(MODEL_RECOVERY_NOTICE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('Responses keeps static instructions singular and maps ordered synthetic system context into input', () => {
    const body = requestBody('openai-responses', providerConversation) as unknown as { instructions: string; input: unknown[] };
    expect(body.instructions).toBe('prefix-instructions');
    const serializedInput = JSON.stringify(body.input);
    const serializedSummary = JSON.stringify(summary.content).slice(1, -1);
    expect(serializedInput.match(/FULL-BRIEF/g)).toHaveLength(1);
    expect(serializedInput.match(/EXACT-COMPILED-NODE/g)).toHaveLength(1);
    expect(serializedInput.indexOf('EXACT-COMPILED-NODE')).toBeLessThan(serializedInput.indexOf(serializedSummary));
    expect(serializedInput.match(new RegExp(MODEL_RECOVERY_NOTICE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('RAW-A');
    expect(JSON.stringify(body)).not.toContain('RAW-B');
  });

  it.each(['openai-chat-completions', 'openai-responses', 'openai-codex-backend'] as const)('admits the actual bounded process projection and hashes its complete %s request bytes', (transportProtocol) => {
    const processId = 'proc-0123456789ab';
    const data = {
      process_id: processId,
      exit_code: 0,
      status: 'exited',
      stdout: 'done',
      stderr: 'partial',
      stdout_complete: true,
      stderr_complete: false,
      stdout_url: `work:///processes/${processId}/stdout.log`,
      stderr_url: `work:///processes/${processId}/stderr.log`,
      stdout_bytes: 4,
      stderr_bytes: 20_000,
    } as const;
    const sourceContent = `${' '.repeat(33_000)}${JSON.stringify({ data, success: true })}`;
    const policies = toolRowPolicies({ content: sourceContent, template: OPERATIONAL_RESULT_POLICY_TEMPLATE });
    const common = { session_id: SESSION, round_id: `r-assistant-${'3'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: TS } as const;
    const call: AgentMessage = {
      ...common,
      id: `${INPUT_A}:tool-call:call-process`,
      role: 'assistant',
      kind: 'tool_call',
      tool: 'run_command',
      tool_call_id: 'call-process',
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-process', type: 'function', function: { name: 'run_command', arguments: '{}' } }] }),
      context_policy: policies.call,
    };
    const result: AgentMessage = {
      ...common,
      id: `${INPUT_A}:tool-result:call-process`,
      role: 'tool',
      kind: 'tool_result',
      tool: 'run_command',
      tool_call_id: 'call-process',
      content: sourceContent,
      context_policy: policies.result,
    };
    const composedProcess = composeContextProjection({ sourceSessionId: SESSION, effectiveHistory: null, dynamicBlocks: [], uncoveredRows: [call, result] });
    const projected = providerConversationFromComposedContext(composedProcess);
    const projectedResult = projected.messages.find((message) => message.kind === 'tool_result');
    if (!projectedResult) throw new Error('Missing projected process result.');
    const projectedData = (JSON.parse(projectedResult.content) as { data: Record<string, unknown> }).data;
    expect(projectedData).not.toHaveProperty('stdout_url');
    expect(projectedData.stderr_url).toBe(data.stderr_url);

    const adapter = selectLlmProtocolAdapter(transportProtocol);
    const plan = buildCandidateRequest({ candidate: CANDIDATE, capabilities: capabilities(transportProtocol), adapter, systemPrompt: 'prefix-instructions', providerConversation: projected, options: OPTS });
    expect(plan.request.serializedBody).toBe(canonicalJson(plan.request.body));
    expect(plan.request.requestHash).toBe(createHash('sha256').update(plan.request.serializedBody, 'utf8').digest('hex'));
    expect(plan.request.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(plan.request.serializedBody, 'utf8') / 4));
    expect(plan.request.serializedBody).toContain(data.stderr_url);
    expect(plan.request.serializedBody).not.toContain(data.stdout_url);
    expect(plan.request.serializedBody).not.toContain(' '.repeat(1_000));
    expect(result.content).toBe(sourceContent);
  });
});
