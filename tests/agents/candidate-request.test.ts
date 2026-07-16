import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { canonicalJson } from '../../src/schemas/index.js';
import type { EffectiveProviderCapabilities } from '../../src/agents/provider-capabilities.js';

const base = { candidate: { provider: 'test', account: null, model: 'model' }, systemPrompt: 'system', messages: [], replay: { sessionId: 'planner:project', messages: [] }, options: { inputId: '00000000-0000-4000-8000-000000000001', phase: 'tools' as const, contract_id: 'planner.v1', contractName: 'planner', terminalToolOffered: [], tools: [], tool_choice: { kind: 'auto' as const }, max_tokens: 321 } };
const capabilities = (transportProtocol: EffectiveProviderCapabilities['transportProtocol']): EffectiveProviderCapabilities => ({ transportProtocol, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', streaming: false, contextWindowTokens: 10000, maxOutputTokens: 1000, quirks: [] });

describe('candidate request admission artifact', () => {
  it.each(['openai-chat-completions', 'openai-codex-backend', 'openai-responses'] as const)('builds and canonicalizes the actual %s body exactly once', (transportProtocol) => {
    const built = buildCandidateRequest({ ...base, capabilities: capabilities(transportProtocol) });
    expect(built.serializedBody).toBe(canonicalJson(built.body));
    expect(built.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(built.serializedBody, 'utf8') / 4));
    expect(built.requestHash).toBe(createHash('sha256').update(built.serializedBody).digest('hex'));
    expect(built.serializedBody).toContain(transportProtocol === 'openai-chat-completions' ? '"max_tokens":321' : '"max_output_tokens":321');
  });
});
