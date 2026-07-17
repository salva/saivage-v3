import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { buildOpenAIResponsesRequest, OpenAIResponsesGateway } from '../../src/agents/llm-openai-responses-gateway.js';
import type { LlmCompleteOptions, ToolDefinition } from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { validateConversationRows } from '../../src/contracts/conversation-compaction.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { compactedConversationFixture } from '../helpers/compacted-conversation-fixture.js';

const CANDIDATE: Candidate = { provider: 'openai', account: null, model: 'gpt-5.6' };
const MSG: AgentMessage = { id: 'm1', session_id: 'analyst:global', role: 'user', kind: 'text', content: 'hi', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:00.000Z' };
const TOOL: ToolDefinition = { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };

afterEach(() => { jest.restoreAllMocks(); });

describe('OpenAI Responses request shape', () => {
  it('sends stateless responses fields and non-strict flat tools', () => {
    const opts: LlmCompleteOptions = { inputId: 'input-1', phase: 'tools', contract_id: 'c', contractName: 'contract', terminalToolOffered: [], tools: [TOOL], tool_choice: { kind: 'required_named', toolName: 'read_file' }, max_tokens: 1234 };
    const body = buildOpenAIResponsesRequest(CANDIDATE, 'sys', { sourceSessionId: 'analyst:global', messages: [MSG] }, opts, { responsesReasoning: { effort: 'medium' } }) as unknown as Record<string, unknown>;

    expect(body.model).toBe('gpt-5.6');
    expect(body.instructions).toBe('sys');
    expect(body.store).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.max_output_tokens).toBe(1234);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toEqual({ type: 'function', name: 'read_file' });
    expect(body.tools).toEqual([{ type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]);
    expect(JSON.stringify(body)).not.toContain('strict');
    expect(body.reasoning).toEqual({ effort: 'medium' });
  });

  it('uses only the latest rendered context and never serializes raw compaction metadata or covered history', () => {
    const opts: LlmCompleteOptions = { inputId: 'input-2', phase: 'tools', contract_id: 'c', contractName: 'contract', terminalToolOffered: [], tools: [], tool_choice: { kind: 'auto' } };
    const latest: AgentMessage = { ...MSG, id: 'c2:rendered', role: 'system', content: 'latest C2 rendered context' };
    const suffix: AgentMessage = { ...MSG, id: 'suffix', content: 'uncovered suffix' };
    const body = buildOpenAIResponsesRequest(CANDIDATE, 'role prompt', { sourceSessionId: 'analyst:global', messages: [latest, suffix] }, opts) as unknown as { instructions: string; input: unknown[] };

    expect(body.instructions).toBe('role prompt\n\n--- system context ---\nlatest C2 rendered context');
    expect(JSON.stringify(body)).not.toContain('older C1 rendered context');
    expect(JSON.stringify(body)).not.toContain('context_compaction');
    expect(JSON.stringify(body.input)).toContain('uncovered suffix');
  });

  it('builds and sends one byte-identical latest-only candidate from validated C1/C2 state', async () => {
    const fixture = compactedConversationFixture('planner:project', true);
    const providerConversation = providerConversationProjection(validateConversationRows('planner:project', fixture.rows));
    const opts: LlmCompleteOptions = { inputId: 'input-3', phase: 'tools', contract_id: 'c', contractName: 'contract', terminalToolOffered: [], tools: [], tool_choice: { kind: 'auto' }, max_tokens: 123 };
    const capabilities = { transportProtocol: 'openai-responses' as const, toolsMode: 'native' as const, exclusiveToolChoiceSupport: 'native' as const, streaming: false, contextWindowTokens: 10000, maxOutputTokens: 1000, quirks: [] };
    const built = buildCandidateRequest({ candidate: CANDIDATE, capabilities, systemPrompt: 'role prompt', providerConversation, options: opts });
    let sentBody: string | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sentBody = init?.body as string;
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200 });
    });

    await new OpenAIResponsesGateway({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', capabilities }).complete(CANDIDATE, 'role prompt', providerConversation, 'planner:project', { ...opts, builtCandidateRequest: built });

    const body = JSON.parse(built.serializedBody) as { instructions: string; input: unknown[] };
    expect(body.instructions).toBe(`role prompt\n\n--- system context ---\nRound one-activation:\n${fixture.c2Summary}\n\nRound two-activation:\n${fixture.c2Summary}`);
    expect(body.instructions).not.toContain(fixture.c1Summary);
    expect(built.serializedBody).not.toContain('context_compaction');
    expect(built.serializedBody).not.toContain('one covered history');
    expect(JSON.stringify(body.input)).toContain('private uncovered output');
    expect(built.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(built.serializedBody, 'utf8') / 4));
    expect(built.requestHash).toBe(createHash('sha256').update(built.serializedBody, 'utf8').digest('hex'));
    expect(sentBody).toBe(built.serializedBody);
  });
});
