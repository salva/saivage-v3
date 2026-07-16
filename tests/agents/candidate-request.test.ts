import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { canonicalJson } from '../../src/schemas/index.js';
import type { EffectiveProviderCapabilities } from '../../src/agents/provider-capabilities.js';

const base = { candidate: { provider: 'test', account: null, model: 'model' }, systemPrompt: 'system', messages: [], replay: { sessionId: 'planner:project', messages: [] }, options: { inputId: '00000000-0000-4000-8000-000000000001', phase: 'tools' as const, contract_id: 'planner.v1', contractName: 'planner', terminalToolOffered: [], tools: [], tool_choice: { kind: 'auto' as const }, max_tokens: 321 } };
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
});
