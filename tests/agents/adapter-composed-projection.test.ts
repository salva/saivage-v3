import { describe, expect, it } from '@jest/globals';

import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { composeContextProjection, providerConversationFromComposedContext } from '../../src/runtime/actors/context/composition-projector.js';
import { buildContentPolicyRefusalMessage } from '../../src/runtime/actors/content-policy-messages.js';
import { DURABLE_PRIMARY_CONTENT_POLICY, MODEL_RECOVERY_NOTICE_TEXT, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { LlmCompleteOptions, ProviderConversationProjection } from '../../src/agents/llm-contracts.js';
import type { ContextBlock } from '../../src/runtime/actors/context/context-blocks.js';

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
  const refusalA = buildContentPolicyRefusalMessage({ sessionId: SESSION, sourceInputId: INPUT_A, candidate: { provider: 'openai', account: null, model: 'gpt-5.6' }, providerResponse: 'RAW-A' });
  const refusalB = buildContentPolicyRefusalMessage({ sessionId: SESSION, sourceInputId: INPUT_B, candidate: { provider: 'openai', account: null, model: 'gpt-5.6' }, providerResponse: 'RAW-B' });
  const composed = composeContextProjection({
    sourceSessionId: SESSION,
    effectiveHistory: { summaryText: 'prior summary', historyMessageId: 'history-block', historyTimestamp: TS, requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null } },
    dynamicBlocks: [{ id: 'prepared-card', role: 'system', content: '{"brief":"FULL-BRIEF"}', storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } } satisfies ContextBlock],
    uncoveredRows: [recoveryRow(INPUT_A), recoveryRow(INPUT_B), userRow('u1', 'first question'), refusalA, refusalB],
  });
  const providerConversation = providerConversationFromComposedContext(composed);
  const identities = providerConversation.messages.map((item) => item.kind === 'synthetic_context' ? item.block_identity : item.id);

  it('projects each repeated recovery and refusal semantic exactly once before adapter mapping', () => {
    expect(identities).toEqual(['prepared-card', 'history-block', `${INPUT_B}:model-recovered`, refusalB.id, 'u1']);
  });

  it('Chat maps the prefix first and the projected system and user notices normally', () => {
    const chat = requestBody('openai-chat-completions', providerConversation) as unknown as { messages: Array<{ role: string; content: string }> };
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'prefix-instructions' });
    expect(chat.messages.slice(1).map((message) => message.role)).toEqual(['system', 'system', 'system', 'user', 'user']);
    expect(chat.messages.filter((message) => message.content === '{"brief":"FULL-BRIEF"}')).toHaveLength(1);
    expect(chat.messages.filter((message) => message.content === 'prefix-instructions')).toHaveLength(1);
    expect(chat.messages.filter((message) => message.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
  });

  it('Codex keeps static instructions singular and maps ordered synthetic system context into input', () => {
    const body = requestBody('openai-codex-backend', providerConversation) as unknown as { instructions: string; input: Array<{ role?: string; content?: unknown }> };
    expect(body.instructions).toBe('prefix-instructions');
    expect(body.input.slice(0, 3).map((item) => item.role)).toEqual(['system', 'system', 'system']);
    expect(JSON.stringify(body.input).match(/FULL-BRIEF/g)).toHaveLength(1);
    expect(JSON.stringify(body.input).match(new RegExp(MODEL_RECOVERY_NOTICE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('Responses keeps static instructions singular and maps ordered synthetic system context into input', () => {
    const body = requestBody('openai-responses', providerConversation) as unknown as { instructions: string; input: unknown[] };
    expect(body.instructions).toBe('prefix-instructions');
    expect(JSON.stringify(body.input).match(/FULL-BRIEF/g)).toHaveLength(1);
    expect(JSON.stringify(body.input).match(new RegExp(MODEL_RECOVERY_NOTICE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('RAW-A');
    expect(JSON.stringify(body)).not.toContain('RAW-B');
  });
});
