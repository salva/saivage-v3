import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { canonicalJson } from '../../src/schemas/index.js';
import type { EffectiveProviderCapabilities } from '../../src/agents/provider-capabilities.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import type { ProviderConversationProjection } from '../../src/agents/llm-contracts.js';

const base = { candidate: { provider: 'test', account: null, model: 'model' }, systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] } satisfies ProviderConversationProjection, options: { inputId: '00000000-0000-4000-8000-000000000001', phase: 'tools' as const, contract_id: 'planner.v1', contractName: 'planner', terminalToolOffered: [], tools: [], tool_choice: { kind: 'auto' as const }, max_tokens: 321 } };
const capabilities = (transportProtocol: EffectiveProviderCapabilities['transportProtocol']): EffectiveProviderCapabilities => ({ transportProtocol, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', streaming: false, contextWindowTokens: 10000, maxOutputTokens: 1000, quirks: [] });

describe('candidate request admission artifact', () => {
  it.each([
    { transportProtocol: 'openai-chat-completions' as const, hasChatLimit: true, hasResponsesLimit: false },
    { transportProtocol: 'openai-responses' as const, hasChatLimit: false, hasResponsesLimit: true },
    { transportProtocol: 'openai-codex-backend' as const, hasChatLimit: false, hasResponsesLimit: false },
  ])('builds and canonicalizes the actual $transportProtocol body exactly once', ({ transportProtocol, hasChatLimit, hasResponsesLimit }) => {
    const built = buildCandidateRequest({ ...base, capabilities: capabilities(transportProtocol) });
    expect(built.serializedBody).toBe(canonicalJson(built.body));
    expect(built.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(built.serializedBody, 'utf8') / 4));
    expect(built.requestHash).toBe(createHash('sha256').update(built.serializedBody).digest('hex'));
    expect(Object.prototype.hasOwnProperty.call(built.body, 'max_tokens')).toBe(hasChatLimit);
    expect(Object.prototype.hasOwnProperty.call(built.body, 'max_output_tokens')).toBe(hasResponsesLimit);
    if (hasChatLimit) expect(built.body.max_tokens).toBe(321);
    if (hasResponsesLimit) expect(built.body.max_output_tokens).toBe(321);
  });

  it('keeps Responses-private output transport-private while admission counts its exact serialized bytes', () => {
    const sourceInputId = '00000000-0000-4000-8000-000000000001';
    const privateContent = 'opaque-provider-private-payload';
    const common = { session_id: 'planner:project' as const, round_id: 'r-assistant-00000000000000000000000000000000', message_index: 1, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' };
    const privateRow: AgentMessage = { ...common, id: 'private', role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: sourceInputId, projection_message_id: 'visible', provider: 'openai', model: 'gpt-5.6', output: [{ type: 'message', content: [{ type: 'output_text', text: privateContent }] }] }) };
    const visible: AgentMessage = { ...common, id: 'visible', role: 'assistant', kind: 'text', content: 'visible summary', provider_projection: { kind: 'openai_responses', source_input_id: sourceInputId, private_message_id: 'private', projection_kind: 'assistant_message' } };
    const providerConversation = { sourceSessionId: 'planner:project', messages: [privateRow, visible] } satisfies ProviderConversationProjection;

    const responses = buildCandidateRequest({ ...base, providerConversation, capabilities: capabilities('openai-responses') });
    expect(responses.serializedBody).toContain(privateContent);
    expect(responses.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(responses.serializedBody, 'utf8') / 4));
    for (const transportProtocol of ['openai-chat-completions', 'openai-codex-backend'] as const) {
      const built = buildCandidateRequest({ ...base, providerConversation, capabilities: capabilities(transportProtocol) });
      expect(built.serializedBody).not.toContain(privateContent);
    }
  });
});
