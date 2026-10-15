import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { canonicalJson } from '../../src/schemas/index.js';
import type { EffectiveProviderCapabilities } from '../../src/contracts/index.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import type { LlmCompleteOptions } from '../../src/contracts/index.js';
import type { ProviderConversationProjection, ToolDefinition } from '../../src/contracts/index.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import type { MaterializedImage, ProviderConversationItem } from '../../src/contracts/index.js';
import { TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';

const tools: ToolDefinition[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'emit_result', description: 'Emit the result.', parameters: { type: 'object' } } },
];
const options: LlmCompleteOptions = { providerSessionId: 'synthetic-provider-session', inputId: '00000000-0000-4000-8000-000000000001', contract_id: 'planner.v1', contractName: 'planner', terminalToolOffered: ['emit_result'], tools, tool_choice: 'auto', temperature: 0.2, max_tokens: 321 };
const base = { candidate: { provider: 'test', account: null, model: 'model' }, systemPrompt: 'system', providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] } satisfies ProviderConversationProjection, options };
const capabilities = (transportProtocol: EffectiveProviderCapabilities['transportProtocol']): EffectiveProviderCapabilities => ({ transportProtocol, imageInput: false, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', contextWindowTokens: 10000, maxOutputTokens: 1000, quirks: [] });

// Literal complete wire bodies: intentionally independent of canonicalJson and the emitters.
// These tiny materialized payloads characterize serialization, not PNG decoding/ingress.
const wireCases = [
  {
    transport: 'openai-responses' as const,
    mixed: '{"include":["reasoning.encrypted_content"],"input":[{"call_id":"original-call","output":[{"text":"{\\"data\\":{\\"label\\":\\"é\\"},\\"success\\":true}","type":"input_text"},{"text":"before é","type":"input_text"},{"image_url":"data:image/png;base64,QQ==","type":"input_image"},{"text":"between","type":"input_text"},{"image_url":"data:image/png;base64,Qg==","type":"input_image"},{"image_url":"data:image/png;base64,QQ==","type":"input_image"}],"type":"function_call_output"},{"content":[{"text":"summary material","type":"input_text"},{"text":"summary first","type":"input_text"},{"image_url":"data:image/png;base64,Qg==","type":"input_image"},{"text":"summary last","type":"input_text"},{"image_url":"data:image/png;base64,QQ==","type":"input_image"}],"role":"user"},{"call_id":"text-call","output":[{"text":"{\\"success\\":true}","type":"input_text"},{"text":"text only","type":"input_text"}],"type":"function_call_output"},{"call_id":"failed-call","output":"{ \\"success\\": false, \\"error\\": \\"failed\\" }","type":"function_call_output"},{"call_id":"contentless-call","output":"{ \\"success\\": true, \\"data\\": null }","type":"function_call_output"}],"instructions":"system","max_output_tokens":321,"model":"model","store":false,"stream":false}',
    mixedHash: '9ef6fbd424000821a023fde054813f4120cff3a2a42b5b5d116bc1418dfc3182',
    empty: '{"include":["reasoning.encrypted_content"],"input":[],"instructions":"system","max_output_tokens":321,"model":"model","store":false,"stream":false}',
    emptyHash: '2bd2513d0ac54cd29903a292aca9d4dbde7ecc4604ea9f37b177b105c79d2254',
  },
  {
    transport: 'openai-codex-backend' as const,
    mixed: '{"input":[{"call_id":"original-call","output":[{"text":"{\\"data\\":{\\"label\\":\\"é\\"},\\"success\\":true}","type":"input_text"},{"text":"before é","type":"input_text"},{"image_url":"data:image/png;base64,QQ==","type":"input_image"},{"text":"between","type":"input_text"},{"image_url":"data:image/png;base64,Qg==","type":"input_image"},{"image_url":"data:image/png;base64,QQ==","type":"input_image"}],"type":"function_call_output"},{"content":[{"text":"summary material","type":"input_text"},{"text":"summary first","type":"input_text"},{"image_url":"data:image/png;base64,Qg==","type":"input_image"},{"text":"summary last","type":"input_text"},{"image_url":"data:image/png;base64,QQ==","type":"input_image"}],"role":"user"},{"call_id":"text-call","output":[{"text":"{\\"success\\":true}","type":"input_text"},{"text":"text only","type":"input_text"}],"type":"function_call_output"},{"call_id":"failed-call","output":"{ \\"success\\": false, \\"error\\": \\"failed\\" }","type":"function_call_output"},{"call_id":"contentless-call","output":"{ \\"success\\": true, \\"data\\": null }","type":"function_call_output"}],"instructions":"system","model":"model","prompt_cache_key":"synthetic-provider-session","store":false,"stream":true}',
    mixedHash: 'd060ab94cbab5bdb649394684250d5b2eb3c0686c7de9ef6c1ebbf0d77a296b7',
    empty: '{"input":[{"content":[{"text":"Proceed with the task described in the instructions.","type":"input_text"}],"role":"user"}],"instructions":"system","model":"model","prompt_cache_key":"synthetic-provider-session","store":false,"stream":true}',
    emptyHash: '632652777c872527eb5605f9d9756a313df560d87958be53aa82b19161a66c86',
  },
];

const imageA: MaterializedImage = { descriptor: { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 32, height: 32, byte_length: 1, sha256: 'a'.repeat(64) }, dataUrl: 'data:image/png;base64,QQ==' };
const imageB: MaterializedImage = { descriptor: { ...imageA.descriptor, id: '00000000-0000-4000-8000-000000000002', width: 64, sha256: 'b'.repeat(64) }, dataUrl: 'data:image/png;base64,Qg==' };
const rowBase = { context_policy: TEXT_ROW_POLICY, session_id: 'agent:planner:project' as const, round_id: 'r-assistant-00000000000000000000000000000000', message_index: 1, block_index: 0, timestamp: '2026-01-01T00:00:00.000Z' };
const resultRow = (id: string, content: string, images?: readonly MaterializedImage[]): ProviderConversationItem => ({ ...rowBase, id, role: 'tool', kind: 'tool_result', tool: 'inspect', tool_call_id: id, content, ...(images ? { images } : {}) });
const mixedConversation: ProviderConversationProjection = {
  sourceSessionId: rowBase.session_id,
  messages: [
    resultRow('original-call', JSON.stringify({ success: true, data: { label: 'é' }, content: [{ type: 'text', text: 'before é' }, { type: 'image', image: imageA.descriptor }, { type: 'text', text: 'between' }, { type: 'image', image: imageB.descriptor }, { type: 'image', image: imageA.descriptor }] }), [imageA, imageB, imageA]),
    { kind: 'synthetic_context', role: 'user', origin: 'summary_material', block_identity: 'summary', content: 'summary material', contentBlocks: [{ type: 'text', text: 'summary first' }, { type: 'image', image: imageB }, { type: 'text', text: 'summary last' }, { type: 'image', image: imageA }] },
    resultRow('text-call', '{"success":true,"content":[{"type":"text","text":"text only"}]}'),
    resultRow('failed-call', '{ "success": false, "error": "failed" }'),
    resultRow('contentless-call', '{ "success": true, "data": null }'),
  ],
};

const replayCases = [
  {
    transport: 'openai-responses' as const, account: null,
    body: '{"include":["reasoning.encrypted_content"],"input":[{"content":[{"text":"system context","type":"input_text"},{"text":"system extra","type":"input_text"}],"role":"system"},{"content":[{"text":"assistant context","type":"output_text"},{"text":"assistant extra","type":"input_text"}],"role":"assistant"},{"content":[{"text":"","type":"input_text"}],"role":"user"},{"content":[{"text":"ordinary assistant","type":"output_text"}],"role":"assistant"},{"encrypted_content":"opaque","type":"reasoning"},{"content":[{"text":"native replay","type":"output_text"}],"type":"message"}],"instructions":"system","max_output_tokens":321,"model":"model","store":false,"stream":false}',
    hash: '1487cfaf39673c860d94958b8ba7c8dc2e31b0e03636b4dfa46b28782120ffaa',
  },
  {
    transport: 'openai-responses' as const, account: 'other',
    body: '{"include":["reasoning.encrypted_content"],"input":[{"content":[{"text":"system context","type":"input_text"},{"text":"system extra","type":"input_text"}],"role":"system"},{"content":[{"text":"assistant context","type":"output_text"},{"text":"assistant extra","type":"input_text"}],"role":"assistant"},{"content":[{"text":"","type":"input_text"}],"role":"user"},{"content":[{"text":"ordinary assistant","type":"output_text"}],"role":"assistant"},{"content":[{"text":"native replay","type":"output_text"}],"type":"message"}],"instructions":"system","max_output_tokens":321,"model":"model","store":false,"stream":false}',
    hash: '68ff27a73b696764e6d276164f67bd98ab301cc2b061aaae4dd56c410cb9c7a6',
  },
  {
    transport: 'openai-codex-backend' as const, account: null,
    body: '{"input":[{"content":"system context","role":"system"},{"content":[{"text":"assistant context","type":"output_text"}],"role":"assistant"},{"content":[{"text":"","type":"input_text"}],"role":"user"},{"content":[{"text":"ordinary assistant","type":"output_text"}],"role":"assistant"},{"content":[{"text":"visible replay","type":"output_text"}],"role":"assistant"}],"instructions":"system","model":"model","prompt_cache_key":"synthetic-provider-session","store":false,"stream":true}',
    hash: 'c27c2cd5c60da2771cd6bec76e95241aa49ff892112d4c6b2a74019e86071aa9',
  },
];

describe('candidate request admission artifact', () => {
  it.each(wireCases)('retains $transport materialization and synthetic-role rejection before emission', ({ transport }) => {
    const tool = mixedConversation.messages[0]!;
    if (tool.kind !== 'tool_result') throw new Error('Expected tool result fixture.');
    const invalidItems: ProviderConversationItem[] = [
      { ...tool, images: [] },
      { ...tool, images: [imageA, imageB, imageA, imageB] },
      { ...tool, images: [imageB, imageB, imageA] },
      resultRow('failed', '{"success":false,"error":"failed"}', [imageA]),
      resultRow('contentless', '{"success":true}', [imageA]),
      { ...rowBase, id: 'stray', kind: 'text', role: 'user', content: 'text', images: [imageA] },
      ...(['system', 'assistant'] as const).map((role): ProviderConversationItem => ({ kind: 'synthetic_context', role, origin: 'summary_material', block_identity: role, content: 'summary', contentBlocks: [{ type: 'image', image: imageA }] })),
    ];
    for (const item of invalidItems) {
      const emitted: unknown[] = [];
      expect(() => selectLlmProtocolAdapter(transport).buildRequestBody({ ...base, capabilities: { ...capabilities(transport), imageInput: true }, providerConversation: { sourceSessionId: rowBase.session_id, messages: [item] }, onImageEmitted: (descriptor) => emitted.push(descriptor) })).toThrow(/materialized|match|user material/);
      expect(emitted).toEqual([]);
    }
  });

  it.each(replayCases)('pins $transport roles and private replay for account $account', ({ transport, account, body, hash }) => {
    const privateId = 'private';
    const sourceInputId = options.inputId;
    const providerConversation: ProviderConversationProjection = { sourceSessionId: rowBase.session_id, messages: [
      { kind: 'synthetic_context', role: 'system', origin: 'dynamic', block_identity: 'system', content: 'system context', contentBlocks: [{ type: 'text', text: 'system extra' }] },
      { kind: 'synthetic_context', role: 'assistant', origin: 'history_summary', block_identity: 'assistant', content: 'assistant context', contentBlocks: [{ type: 'text', text: 'assistant extra' }] },
      { ...rowBase, id: 'user', role: 'user', kind: 'text', content: '' },
      { ...rowBase, id: 'assistant', role: 'assistant', kind: 'text', content: 'ordinary assistant' },
      { ...rowBase, id: privateId, role: 'system', kind: 'provider_private', context_policy: { kind: 'structural', behavior: 'responses_private' }, content: JSON.stringify({ transport: 'openai-responses', producer_account_id: responsesProducerAccountId(base.candidate), source_input_id: sourceInputId, projection_message_id: 'visible', provider: 'test', model: 'model', output: [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'message', content: [{ type: 'output_text', text: 'native replay' }] }] }) },
      { ...rowBase, id: 'visible', role: 'assistant', kind: 'text', content: 'visible replay', provider_projection: { kind: 'openai_responses', source_input_id: sourceInputId, private_message_id: privateId, projection_kind: 'assistant_message' } },
    ] };
    const request = buildCandidateRequest({ ...base, candidate: { ...base.candidate, account }, providerConversation, options: { ...options, tools: [] }, capabilities: capabilities(transport), adapter: selectLlmProtocolAdapter(transport) }).request;
    expect(Buffer.from(request.serializedBody, 'utf8')).toEqual(Buffer.from(body, 'utf8'));
    expect(request.requestHash).toBe(hash);
    expect(request.imageCount).toBe(0);
    expect(request.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(body, 'utf8') / 4));
    const input = request.body.input as Array<Record<string, unknown>>;
    expect(input.slice(0, 4).map((item) => item.role)).toEqual(['system', 'assistant', 'user', 'assistant']);
    expect(request.serializedBody.includes('opaque')).toBe(transport === 'openai-responses' && account === null);
    expect(request.serializedBody.includes('native replay')).toBe(transport === 'openai-responses');
    expect(request.serializedBody.includes('visible replay')).toBe(transport === 'openai-codex-backend');
  });
  it.each(wireCases)('pins complete UTF-8 image/summary/error bytes and occurrence accounting for $transport', ({ transport, mixed, mixedHash, empty, emptyHash }) => {
    const adapter = selectLlmProtocolAdapter(transport);
    const args = { ...base, options: { ...options, tools: [] }, adapter, capabilities: { ...capabilities(transport), imageInput: true } };
    const request = buildCandidateRequest({ ...args, providerConversation: mixedConversation }).request;
    expect(Buffer.from(request.serializedBody, 'utf8')).toEqual(Buffer.from(mixed, 'utf8'));
    expect(request.requestHash).toBe(mixedHash);
    expect(request.imageCount).toBe(5);
    // A=2 and B=4 raster tokens; actual occurrences A,B,A,B,A reserve 14.
    expect(request.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(mixed, 'utf8') / 4) + 14);
    const emitted: unknown[] = [];
    adapter.buildRequestBody({ ...args, providerConversation: mixedConversation, onImageEmitted: (descriptor) => emitted.push(descriptor) });
    expect(emitted).toEqual([imageA.descriptor, imageB.descriptor, imageA.descriptor, imageB.descriptor, imageA.descriptor]);
    const input = request.body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ call_id: 'original-call', type: 'function_call_output' });
    expect((input[0]!.output as Array<{ type: string }>).map((part) => part.type)).toEqual(['input_text', 'input_text', 'input_image', 'input_text', 'input_image', 'input_image']);
    expect(input[1]).toMatchObject({ role: 'user' });
    expect(input.slice(3).map((item) => item.output)).toEqual(['{ "success": false, "error": "failed" }', '{ "success": true, "data": null }']);
    const emptyRequest = buildCandidateRequest(args).request;
    expect(Buffer.from(emptyRequest.serializedBody, 'utf8')).toEqual(Buffer.from(empty, 'utf8'));
    expect(emptyRequest.requestHash).toBe(emptyHash);
    expect(emptyRequest.imageCount).toBe(0);
    expect(emptyRequest.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(empty, 'utf8') / 4));
  });
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
    const common = { context_policy: { kind: 'structural', behavior: 'responses_private' } as const, session_id: 'agent:planner:project' as const, round_id: 'r-assistant-00000000000000000000000000000000', message_index: 1, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' };
    const privateRow: AgentMessage = { ...common, id: 'private', role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', producer_account_id: responsesProducerAccountId({ provider: 'openai', account: null }), source_input_id: sourceInputId, projection_message_id: 'visible', provider: 'openai', model: 'gpt-5.6', output: [{ type: 'message', content: [{ type: 'output_text', text: privateContent }] }] }) };
    const visible: AgentMessage = { ...common, context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true }, id: 'visible', role: 'assistant', kind: 'text', content: 'visible summary', provider_projection: { kind: 'openai_responses', source_input_id: sourceInputId, private_message_id: 'private', projection_kind: 'assistant_message' } };
    const providerConversation = { sourceSessionId: 'agent:planner:project', messages: [privateRow, visible] } satisfies ProviderConversationProjection;

    const responses = buildCandidateRequest({ ...base, providerConversation, capabilities: capabilities('openai-responses'), adapter: selectLlmProtocolAdapter('openai-responses') }).request;
    expect(responses.serializedBody).toContain(privateContent);
    expect(responses.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(responses.serializedBody, 'utf8') / 4));
    for (const transportProtocol of ['openai-chat-completions', 'openai-codex-backend'] as const) {
      const built = buildCandidateRequest({ ...base, providerConversation, capabilities: capabilities(transportProtocol), adapter: selectLlmProtocolAdapter(transportProtocol) }).request;
      expect(built.serializedBody).not.toContain(privateContent);
    }
  });
});
