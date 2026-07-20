import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { canonicalJson } from '../../src/schemas/index.js';
import type { EffectiveProviderCapabilities } from '../../src/agents/provider-capabilities.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import type { LlmCompleteOptions, ProviderConversationProjection, ToolDefinition } from '../../src/agents/llm-contracts.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';

const tools: ToolDefinition[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'emit_result', description: 'Emit the result.', parameters: { type: 'object' } } },
];
const options: LlmCompleteOptions = { inputId: '00000000-0000-4000-8000-000000000001', contract_id: 'planner.v1', contractName: 'planner', terminalToolOffered: ['emit_result'], tools, tool_choice: 'auto', max_tokens: 321 };
const base = { candidate: { provider: 'test', account: null, model: 'model' }, systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] } satisfies ProviderConversationProjection, options };
const capabilities = (transportProtocol: EffectiveProviderCapabilities['transportProtocol']): EffectiveProviderCapabilities => ({ transportProtocol, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', streaming: false, contextWindowTokens: 10000, maxOutputTokens: 1000, quirks: [] });

describe('candidate request admission artifact', () => {
  it.each([
    { transportProtocol: 'openai-chat-completions' as const, hasChatLimit: true, hasResponsesLimit: false },
    { transportProtocol: 'openai-responses' as const, hasChatLimit: false, hasResponsesLimit: true },
    { transportProtocol: 'openai-codex-backend' as const, hasChatLimit: false, hasResponsesLimit: false },
  ])('builds and canonicalizes the actual $transportProtocol body exactly once', ({ transportProtocol, hasChatLimit, hasResponsesLimit }) => {
    const plan = buildCandidateRequest({ ...base, capabilities: capabilities(transportProtocol), adapter: selectLlmProtocolAdapter(transportProtocol) });
    const built = plan.request;
    expect(built.serializedBody).toBe(canonicalJson(built.body));
    expect(built.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(built.serializedBody, 'utf8') / 4));
    expect(built.requestHash).toBe(createHash('sha256').update(built.serializedBody).digest('hex'));
    expect(Object.prototype.hasOwnProperty.call(built.body, 'max_tokens')).toBe(hasChatLimit);
    expect(Object.prototype.hasOwnProperty.call(built.body, 'max_output_tokens')).toBe(hasResponsesLimit);
    if (hasChatLimit) expect(built.body.max_tokens).toBe(321);
    if (hasResponsesLimit) expect(built.body.max_output_tokens).toBe(321);
    const serializedTools = JSON.stringify(built.body.tools);
    expect(serializedTools.indexOf('read_file')).toBeLessThan(serializedTools.indexOf('emit_result'));
    expect(built.body.tool_choice).toBe('auto');
    expect(built.body.parallel_tool_calls).toBe(false);
  });

  it('keeps Responses-private output transport-private while admission counts its exact serialized bytes', () => {
    const sourceInputId = '00000000-0000-4000-8000-000000000001';
    const privateContent = 'opaque-provider-private-payload';
    const common = { session_id: 'planner:project' as const, round_id: 'r-assistant-00000000000000000000000000000000', message_index: 1, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' };
    const privateRow: AgentMessage = { ...common, id: 'private', role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: sourceInputId, projection_message_id: 'visible', provider: 'openai', model: 'gpt-5.6', output: [{ type: 'message', content: [{ type: 'output_text', text: privateContent }] }] }) };
    const visible: AgentMessage = { ...common, id: 'visible', role: 'assistant', kind: 'text', content: 'visible summary', provider_projection: { kind: 'openai_responses', source_input_id: sourceInputId, private_message_id: 'private', projection_kind: 'assistant_message' } };
    const providerConversation = { sourceSessionId: 'planner:project', messages: [privateRow, visible] } satisfies ProviderConversationProjection;

    const responses = buildCandidateRequest({ ...base, providerConversation, capabilities: capabilities('openai-responses'), adapter: selectLlmProtocolAdapter('openai-responses') }).request;
    expect(responses.serializedBody).toContain(privateContent);
    expect(responses.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(responses.serializedBody, 'utf8') / 4));
    for (const transportProtocol of ['openai-chat-completions', 'openai-codex-backend'] as const) {
      const built = buildCandidateRequest({ ...base, providerConversation, capabilities: capabilities(transportProtocol), adapter: selectLlmProtocolAdapter(transportProtocol) }).request;
      expect(built.serializedBody).not.toContain(privateContent);
    }
  });
});
