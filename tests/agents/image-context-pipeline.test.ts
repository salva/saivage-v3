import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, jest } from '@jest/globals';
import { canonicalJson, type AgentMessage } from '../../src/schemas/index.js';
import {
  imageAccountingBytes,
  toolContentSucceeded,
  imageEstimatedTokens,
  rasterReservation,
  classifyCandidateLocalAdmission,
  providerItemImageDescriptors,
  capabilityRequestForTools,
  MAX_IMAGE_REQUEST_BYTES,
  type ProviderConversationProjection,
  type ImageDescriptor,
  type ToolResultContentBlock,
  type LlmCompleteOptions,
} from '../../src/contracts/index.js';
import {
  publishConversationImage,
  materializeConversationImage,
  appendConversationBatch,
  readConversation,
} from '../../src/persistence/session-api.js';
import { conversationImageFile } from '../../src/persistence/layout.js';
import { materializeProviderConversation } from '../../src/application/conversation-image-materialization.js';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import {
  compact,
  prepareCompaction,
} from '../../src/runtime/actors/compaction/compactor.js';
import {
  buildSummaryRequestInput,
  admitSummaryRequest,
  type SummarizerProviderPort,
} from '../../src/runtime/actors/compaction/summarizer.js';
import {
  createSequentialRefineAccumulator,
  SummaryConstructionLimitError,
} from '../../src/runtime/actors/compaction/refine-accumulator.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import {
  toolRowPolicies,
  ACTIVITY_ROW_POLICY,
  TEXT_ROW_POLICY,
} from '../helpers/row-policy-fixtures.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { Provider } from '../../src/agents/provider.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, MCP_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { createInvocationServiceProvider } from '../../src/application/invocation-service-provider.js';
import { invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import { executeLlmProviderAttempt } from '../../src/agents/llm-provider-attempt.js';
import { makeCodexJwt } from '../helpers/llm-test-helpers.js';
import { projectProviderExchangeForPublication } from '../../src/agents/provider-exchange-projection.js';
import { ProviderTurnFailure, LlmRequestError } from '../../src/contracts/index.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { testLlmToolInvocationContext, unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';

const SESSION = 'agent:planner:project' as const;
const encodedPartBytes = (image: ImageDescriptor) => JSON.stringify({ type: 'input_image', image_url: '' }).length + 'data:image/png;base64,'.length + 4 * Math.ceil(image.byte_length / 3);
// Test-side observations only; production compactor helpers stay owner-internal.
const composedProviderConversationAccountingBytes = (projection: ProviderConversationProjection) => Buffer.byteLength(JSON.stringify(projection.messages.map(item => item.kind === 'synthetic_context' ? [item.kind, item.origin, item.block_identity, item.role, item.content] : [item.id, item.role, item.kind, item.content]))) + projection.messages.flatMap(providerItemImageDescriptors).reduce((sum, image) => sum + imageAccountingBytes(image), 0);
const estimateProviderConversationTokens = (projection: ProviderConversationProjection) => Math.ceil(composedProviderConversationAccountingBytes(projection) / 4);
const INPUT = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-07T00:00:00.000Z';
const candidate = { provider: 'fixture', account: null, model: 'gpt-6.1-sol' } as const;
const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const result = mkdtempSync('/home/salva/g/ml/tmp/image-context-');
  roots.push(result);
  initProjectTree(result);
  return result;
}
function options(): LlmCompleteOptions {
  return {
    inputId: INPUT,
    providerSessionId: 'image-test',
    contract_id: 'test',
    contractName: 'planner',
    terminalToolOffered: [],
    temperature: 0,
    max_tokens: 2000,
    tools: [],
    tool_choice: 'auto',
  };
}
function plan(
  projection: ProviderConversationProjection,
  protocol:
    | 'openai-responses'
    | 'openai-codex-backend'
    | 'openai-chat-completions' = 'openai-responses',
  model = 'gpt-6.1-sol',
) {
  const selected = { ...candidate, model };
  const capabilities = new Provider('fixture', {
    models: [model],
    capabilities: {
      transportProtocol: protocol,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    },
  }).getEffectiveCapabilities(model, null);
  return buildCandidateRequest({
    candidate: selected,
    capabilities,
    adapter: selectLlmProtocolAdapter(protocol),
    systemPrompt: 'system',
    providerConversation: projection,
    options: options(),
  });
}
function rows(image: ImageDescriptor, alternateProducer = false, contentBlocks: readonly ToolResultContentBlock[] = [{ type: 'image', image }], nativeResult?: string): AgentMessage[] {
  const tool = nativeResult ? 'mcp_tool_call' : alternateProducer ? 'fixture_image_producer' : 'view_image';
  const data = {
    source_path: 'screen.png',
    source_dimensions: { width: image.width, height: image.height },
    oriented_dimensions: { width: image.width, height: image.height },
    sent_dimensions: { width: image.width, height: image.height },
    orientation_applied: false,
    resized: false,
    scale: { x: 1, y: 1 },
    max_dimension: 'original',
  };
  const content = nativeResult ?? settleToolActionOutcome(toolContentSucceeded(alternateProducer ? { caption: 'fixture' } : data, contentBlocks)).settledResultBytes;
  const policies = toolRowPolicies({
    content,
    template: nativeResult ? MCP_RESULT_POLICY_TEMPLATE : {
      ...OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      settledAudience: 'primary_and_summarizer',
    },
    evidence: nativeResult ? { kind: 'none' } : {
      kind: 'observational_query',
      observedSha256: createHash('sha256').update(content).digest('hex'),
    },
  });
  const base = {
    session_id: SESSION,
    round_id: `r-assistant-${'0'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
    timestamp,
  };
  return [
    {
      ...base,
      id: 'activation',
      role: 'system',
      kind: 'activity',
      context_policy: ACTIVITY_ROW_POLICY,
      content: JSON.stringify({
        event: 'activation_open',
        agent_name: 'planner',
        card_id: 'project',
        input_id: INPUT,
        timestamp,
      }),
    },
    {
      ...base,
      id: `${INPUT}:tool-call:call-image`,
      role: 'assistant',
      kind: 'tool_call',
      tool,
      tool_call_id: 'call-image',
      context_policy: policies.call,
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [
          {
            id: 'call-image',
            type: 'function',
            function: { name: tool, arguments: alternateProducer ? '{}' : '{"path":"screen.png"}' },
          },
        ],
      }),
    },
    {
      ...base,
      id: `${INPUT}:tool-result:call-image`,
      role: 'tool',
      kind: 'tool_result',
      tool,
      tool_call_id: 'call-image',
      context_policy: policies.result,
      content,
    },
  ];
}
async function fixture(width = 1600, height = 1600) {
  const projectRoot = root();
  const bytes = await sharp({
    create: { width, height, channels: 4, background: { r: 23, g: 54, b: 89, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  const descriptor = publishConversationImage(projectRoot, SESSION, bytes, { width, height });
  appendConversationBatch({ projectRoot }, rows(descriptor));
  const conversation = readConversation(projectRoot, SESSION);
  return {
    projectRoot,
    bytes,
    descriptor,
    conversation,
    projection: providerConversationProjection(conversation, []),
  };
}

it.each(['agent:planner:project', 'agent:analyst:global'] as const)(
  'preserves ordered text/image/text/two-image results from exact %s selection to both call-linked transports and atomic summary material',
  async (sessionId) => {
    const projectRoot = root();
    const bytes = await sharp({ create: { width: 13, height: 7, channels: 3, background: '#abcdef' } }).png().toBuffer();
    const nativeEnvelope = { content: [
      { type: 'text', text: 'before native image' }, { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
      { type: 'text', text: '{"type":"image","image_url":"ordinary JSON-looking text"}' },
      { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }, { type: 'text', text: 'after native image' },
    ], structuredContent: { type: 'image', data: 'opaque structured lookalike' } };
    const scope = sessionId === 'agent:analyst:global' ? 'global' : 'card';
    const surface = new BoundAgentToolSet([resolveRuntimeTool(scope, 'mcp_tool_call')]).bind({
      scope, agentName: scope === 'global' ? 'analyst' : 'planner', projectRoot,
      mcpToolInvocation: { ...unusedMcpToolInvocation, invokeTool: async () => nativeEnvelope, findToolCapability: () => null },
    } as never);
    const invocation = await invokeToolForLlm(surface, 'mcp_tool_call', { serverName: 'native-fixture', toolName: 'capture' },
      testLlmToolInvocationContext({ sessionId, sourceInputId: INPUT, toolCallId: 'call-image', toolName: 'mcp_tool_call' }));
    expect(invocation.kind).toBe('executed');
    const settled = settleToolActionOutcome(invocation.kind === 'executed' ? invocation.execution.providerOutcome : invocation.providerOutcome);
    if (!settled.providerResult.success || !settled.providerResult.content) throw new Error('Expected native content');
    const blocks = settled.providerResult.content;
    if (blocks[1]?.type !== 'image' || blocks[3]?.type !== 'image') throw new Error('Expected two native images');
    const first = blocks[1].image;
    const second = blocks[3].image;
    const selectedBytes = Buffer.from((await materializeConversationImage(projectRoot, sessionId, first)).dataUrl.split(',')[1]!, 'base64');
    const sourceRows = rows(first, true, blocks, settled.settledResultBytes).map((row) => ({ ...row, session_id: sessionId }));
    sourceRows[1] = { ...sourceRows[1]!, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-image', type: 'function', function: {
      name: 'mcp_tool_call', arguments: JSON.stringify({ serverName: 'native-fixture', toolName: 'capture' }),
    } }] }) };
    if (sessionId === 'agent:analyst:global') sourceRows[0] = {
      ...sourceRows[0]!, content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: INPUT, timestamp }),
    };
    appendConversationBatch({ projectRoot }, sourceRows);
    const conversation = readConversation(projectRoot, sessionId);
    expect(JSON.parse(conversation.physicalRows[2]!.content).content).toEqual(blocks);
    const selected = providerConversationProjection(conversation, []);
    expect(selected.messages.flatMap(providerItemImageDescriptors)).toEqual([first, second]);
    const materialized = await materializeProviderConversation(projectRoot, selected);
    for (const protocol of ['openai-responses', 'openai-codex-backend'] as const) {
      const built = plan(materialized, protocol);
      const input = (built.request.body as { input: Array<Record<string, unknown>> }).input;
      const outputs = input.filter((item) => item.type === 'function_call_output');
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.call_id).toBe('call-image');
      expect(input.filter((item) => item.role === 'user')).toHaveLength(0);
      const parts = outputs[0]!.output as Array<Record<string, unknown>>;
      expect(parts.map((part) => part.type)).toEqual(['input_text', 'input_text', 'input_image', 'input_text', 'input_image', 'input_text']);
      expect(parts[1]!.text).toBe(blocks[0]!.type === 'text' ? blocks[0]!.text : '');
      expect(parts[3]!.text).toContain('ordinary JSON-looking text');
      expect(parts[5]!.text).toBe('after native image');
      for (const index of [2, 4]) expect(Buffer.from(String(parts[index]!.image_url).split(',')[1]!, 'base64')).toEqual(selectedBytes);
      expect(parts.filter((part) => part.type === 'input_text').some((part) => String(part.text).includes('base64'))).toBe(false);
      expect(built.request.imageCount).toBe(2);
      expect(built.request.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(built.request.serializedBody) / 4) + rasterReservation(first) + rasterReservation(second));
      await expect(materializeProviderConversation(projectRoot, { ...selected, sourceSessionId: sessionId === SESSION ? 'agent:analyst:global' : SESSION })).rejects.toThrow(/belongs to session/);
    }
    const base = summaryProvider(projectRoot, 'ordered visual summary', []);
    const completeTurn = jest.fn<SummarizerProviderPort['completeTurn']>(async (input, admitted) => {
      const built = plan(input.providerConversation);
      expect(built.request.serializedBody).toBe(admitted.serializedRequest);
      const source = input.providerConversation.messages.filter((item) => item.kind === 'synthetic_context' && item.contentBlocks);
      expect(source).toHaveLength(1);
      expect(source[0]!.role).toBe('user');
      const wrapper = JSON.parse(source[0]!.content.slice(source[0]!.content.indexOf('\n') + 1));
      expect(wrapper).toEqual({
        tool: 'mcp_tool_call',
        arguments: JSON.stringify({ serverName: 'native-fixture', toolName: 'capture' }),
        result: { success: true, data: settled.providerResult.data },
      });
      expect(wrapper.result).not.toHaveProperty('content');
      const wire = (built.request.body as { input: Array<Record<string, unknown>> }).input;
      expect(wire.some((item) => item.type === 'function_call_output')).toBe(false);
      const multimodal = wire.find((item) => item.role === 'user' && Array.isArray(item.content) && (item.content as Array<Record<string, unknown>>).some((part) => part.type === 'input_image'))!;
      expect((multimodal.content as Array<Record<string, unknown>>).map((part) => part.type)).toEqual(['input_text', 'input_text', 'input_image', 'input_text', 'input_image', 'input_text']);
      return { result: { kind: 'message', content: 'ordered visual summary' }, provider_exchanges: [] };
    });
    const accumulator = createSequentialRefineAccumulator({ conversation, inheritedHistory: null, preparedBlocks: [], summarizerProvider: { ...base, completeTurn }, budget: { contextUtilizationFraction: 0.8 }, signal: new AbortController().signal, progress: noCompactionProgress });
    await expect(accumulator.materializeThrough(conversation.sourceRows.length)).resolves.toBe('ordered visual summary');
    expect(completeTurn).toHaveBeenCalledTimes(1);
  },
);
function invocation(
  projection: ProviderConversationProjection,
  tail = 0,
): PreparedLlmInvocationInput {
  const preparedCompaction = prepareCompaction(
    {
      context_utilization_fraction: 0.8,
      trigger_fraction: 0.8,
      tail_fraction: tail,
      snap: 'compact_straddler',
    },
    'system',
    [],
    20_000,
    2000,
  );
  return {
    inputId: INPUT,
    agentId: SESSION,
    agentName: 'planner',
    sessionId: SESSION,
    systemPrompt: 'system',
    providerConversation: projection,
    tools: [],
    compiledToolContracts: [],
    terminalToolNames: [],
    modelParams: { temperature: 0 },
    preparedCompaction,
    preparedContext: buildPreparedInvocationContext({
      instructionText: 'system',
      terminalToolNames: [],
      compiledTools: [],
      dynamicBlocks: [],
      preparedCompaction,
    }),
    capabilityRequest: {},
    routePass: { kind: 'ordinary', candidateChain: [candidate] },
    episodeContext: {},
  };
}

it('serializes text-only typed content in order without image authority or a synthetic primary user utterance', async () => {
  const projectRoot = root();
  const descriptor: ImageDescriptor = { id: '11111111-1111-4111-8111-111111111111', mime_type: 'image/png', width: 1, height: 1, byte_length: 1, sha256: 'a'.repeat(64) };
  appendConversationBatch({ projectRoot }, rows(descriptor, true, [
    { type: 'text', text: '{"type":"image","data":"ordinary text"}' },
    { type: 'text', text: 'final native text' },
  ]));
  const projection = await materializeProviderConversation(projectRoot, providerConversationProjection(readConversation(projectRoot, SESSION), []));
  expect(projection.messages.flatMap(providerItemImageDescriptors)).toEqual([]);
  for (const protocol of ['openai-responses', 'openai-codex-backend'] as const) {
    const built = plan(projection, protocol);
    const input = (built.request.body as { input: Array<Record<string, unknown>> }).input;
    const outputs = input.filter(item => item.type === 'function_call_output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.call_id).toBe('call-image');
    expect((outputs[0]!.output as Array<Record<string, unknown>>).map(part => part.text)).toEqual([
      '{"data":{"caption":"fixture"},"success":true}',
      '{"type":"image","data":"ordinary text"}', 'final native text',
    ]);
    expect(built.request.imageCount).toBe(0);
    expect(input.some(item => item.role === 'user')).toBe(false);
  }
});
it.each(['openai-responses', 'openai-codex-backend'] as const)('materializes an alternate canonical producer through %s from its descriptor alone', async (protocol) => {
  const projectRoot = root();
  const bytes = await sharp({ create: { width: 33, height: 65, channels: 4, background: '#123456' } }).png().toBuffer();
  const descriptor = publishConversationImage(projectRoot, SESSION, bytes, { width: 33, height: 65 });
  appendConversationBatch({ projectRoot }, rows(descriptor, true));
  const projection = providerConversationProjection(readConversation(projectRoot, SESSION), []);
  expect(projection.messages.flatMap(providerItemImageDescriptors)).toEqual([descriptor]);
  const materialized = await materializeProviderConversation(projectRoot, projection);
  const built = plan(materialized, protocol);
  const output = (JSON.parse(built.request.serializedBody).input as Array<Record<string, unknown>>).find(item => item.type === 'function_call_output')!;
  const image = (output.output as Array<Record<string, unknown>>).find(item => item.type === 'input_image')!;
  expect(Buffer.from(String(image.image_url).split(',')[1]!, 'base64')).toEqual(bytes);
  expect(built.request.imageCount).toBe(1);
  expect(built.request.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(built.request.serializedBody) / 4) + rasterReservation(descriptor));
  expect(composedProviderConversationAccountingBytes(materialized)).toBe(composedProviderConversationAccountingBytes(projection));
  unlinkSync(conversationImageFile(projectRoot, SESSION, descriptor.id));
  await expect(materializeProviderConversation(projectRoot, projection)).rejects.toThrow();
});

function summaryProvider(
  projectRoot: string,
  output: string,
  seen: string[],
): SummarizerProviderPort {
  return {
    candidate,
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    materializeImage: (session, descriptor) =>
      materializeConversationImage(projectRoot, session, descriptor),
    serializeSummaryRequest(input) {
      const built = plan(input.providerConversation);
      return {
        serializedRequest: built.request.serializedBody,
        requestSha256: built.request.requestHash,
        estimatedInputTokens: built.request.estimatedWireInputTokens,
        imageCount: built.request.imageCount,
      };
    },
    async completeTurn(input, admitted) {
      const built = plan(input.providerConversation);
      expect(built.request.serializedBody).toBe(admitted.serializedRequest);
      for (const item of input.providerConversation.messages)
        if (item.kind === 'synthetic_context')
          for (const block of item.contentBlocks ?? []) if (block.type === 'image') seen.push(block.image.dataUrl);
      return { result: { kind: 'message', content: output }, provider_exchanges: [] };
    },
    projectProviderExchanges: jest.fn(),
  };
}

it.each(['local_exact_admission', 'preventive', 'authoritative_context_recovery'] as const)(
  'ranks two image-weighted %s endpoints by the established strategy, not growing textual tuples',
  async (strategy) => {
    const f = await fixture();
    const projectRoot = root();
    const descriptor = publishConversationImage(projectRoot, SESSION, f.bytes, {
      width: 1600,
      height: 1600,
    });
    const sourceRows = rows(descriptor);
    const prefix: AgentMessage = {
      ...sourceRows[0]!,
      id: 'older-prefix',
      role: 'user',
      kind: 'text',
      content: 'older notes '.repeat(3000),
      context_policy: TEXT_ROW_POLICY,
    };
    appendConversationBatch({ projectRoot }, [sourceRows[0]!, prefix, ...sourceRows.slice(1)]);
    const projection = await materializeProviderConversation(
      projectRoot,
      providerConversationProjection(readConversation(projectRoot, SESSION), []),
    );
    const seen: string[] = [];
    const base = summaryProvider(projectRoot, 'unused', seen);
    let folds = 0;
    const provider: SummarizerProviderPort = {
      ...base,
      async completeTurn(input, admitted, signal) {
        const completion = await base.completeTurn(input, admitted, signal);
        return {
          ...completion,
          result: {
            kind: 'message',
            content: ++folds === 1 ? 'short prefix summary' : 'larger visual summary '.repeat(150),
          },
        };
      },
    };
    const result = await compact({
      strategy,
      conversations: { projectRoot },
      input: invocation(projection, 0.1),
      summarizerProvider: provider,
      signal: new AbortController().signal,
      progress: noCompactionProgress,
    });
    if (result.kind !== 'compacted') throw new Error('Expected image-weighted endpoint selection.');
    const retained = result.providerConversation.messages.flatMap(providerItemImageDescriptors);
    expect(retained.length).toBe(strategy === 'authoritative_context_recovery' ? 1 : 0);
    expect(folds).toBe(strategy === 'authoritative_context_recovery' ? 1 : 2);
    expect(seen).toHaveLength(strategy === 'authoritative_context_recovery' ? 0 : 1);
  },
);

it.each(['openai-responses', 'openai-codex-backend'] as const)(
  'sends selected pixels as pure %s image output, omitted detail, exact wire+raster heuristic on both models',
  async (protocol) => {
    const f = await fixture(33, 65);
    const projection = await materializeProviderConversation(f.projectRoot, f.projection);
    for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) {
      const built = plan(projection, protocol, model);
      const output = (built.request.body.input as Array<Record<string, unknown>>).find(
        (item) => item.type === 'function_call_output',
      )!;
      expect(output.call_id).toBe('call-image');
      const parts = output.output as Array<Record<string, unknown>>;
      const { content, ...metadata } = JSON.parse(rows(f.descriptor)[2]!.content);
      expect(parts[0]).toEqual({ type: 'input_text', text: canonicalJson(metadata) });
      expect(parts[1]!.type).toBe('input_image');
      expect(parts[1]).not.toHaveProperty('detail');
      expect(Buffer.from(String(parts[1]!.image_url).split(',')[1]!, 'base64')).toEqual(f.bytes);
      expect(built.request.estimatedWireInputTokens).toBe(
        Math.ceil(Buffer.byteLength(built.request.serializedBody) / 4) + 12,
      );
      expect(built.request.requestHash).toBe(
        createHash('sha256').update(built.request.serializedBody).digest('hex'),
      );
    }
    expect(() => plan(f.projection, protocol)).toThrow(/materialized/);
  },
);

it.each(['openai-responses', 'openai-codex-backend'] as const)('suppresses %s echoed image HTTP bodies without losing structured classifications or bounded evidence', async protocol => {
  const f = await fixture(33, 65);
  const projection = await materializeProviderConversation(f.projectRoot, f.projection);
  const provider = protocol === 'openai-codex-backend' ? 'openai-codex' : 'fixture';
  const selected = { ...candidate, provider };
  const registry = invocationProviderRegistry([selected], { [provider]: { transportProtocol: protocol } }, { [provider]: protocol === 'openai-codex-backend' ? makeCodexJwt('synthetic-account') : 'synthetic-test-key' });
  const built = { ...plan(projection, protocol), candidate: selected };
  const imageRow = projection.messages.find(item => item.kind === 'tool_result')!;
  if (imageRow.kind === 'synthetic_context' || !imageRow.images?.length) throw new Error('Expected materialized result');
  const dataUrl = imageRow.images[0]!.dataUrl;
  for (const [status, code, kind] of [[400, 'context_length_exceeded', 'input_context_exhausted'], [429, 'rate_limit_exceeded', 'rate_limit'], [401, 'invalid_api_key', 'auth_permanent'], [503, 'server_is_overloaded', 'server_transient'], [400, 'unrecognized_error', 'provider_protocol_error']] as const) {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code, type: status === 400 ? 'invalid_request_error' : code, param: 'input', message: `${dataUrl} /images/private.png` } }), { status, ...(status === 429 ? { headers: { 'retry-after': '2' } } : {}) }));
    let failure: ProviderTurnFailure | undefined;
    try { await executeLlmProviderAttempt({ projectRoot: f.projectRoot, registry, plan: built, options: options(), capabilityRequest: { requiresImages: true }, attemptContext: { sourceSessionId: SESSION, invocationSessionId: SESSION, inputId: options().inputId, purpose: 'primary', attemptIndex: 0 } }); }
    catch (error) { if (!(error instanceof ProviderTurnFailure)) throw error; failure = error; }
    expect(failure).toBeDefined();
    const original = failure!.originalFailure;
    if (!(original instanceof LlmRequestError)) throw original;
    expect(original.failure).toMatchObject({ kind, status });
    if (status === 429) expect(original.failure).toMatchObject({ retryAfterMs: 2000 });
    const evidence = projectProviderExchangeForPublication({ ...failure!.provider_exchanges[0]!, attempt_index: 0 }, { assistantOutputIds: [], terminalConversationOutputId: 'error-row' });
    expect(evidence.request_params.endpoint).toMatch(/^https:\/\//);
    expect(evidence.request_params).not.toHaveProperty('input');
    expect(JSON.stringify({ failure: original.failure, evidence })).not.toMatch(/data:image|base64|\/images\//);
    expect(JSON.stringify(evidence)).toContain(String(status));
    fetch.mockRestore();
  }
  const terminal = { id: 'synthetic-failed', status: 'failed', error: { code: 'context_length_exceeded', type: 'invalid_request_error', param: 'input', message: `${dataUrl} /images/private.png` } };
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(protocol === 'openai-responses' ? JSON.stringify(terminal) : `data: ${JSON.stringify({ type: 'response.failed', response: terminal })}\n\n`, { status: 200, headers: { 'content-type': protocol === 'openai-responses' ? 'application/json' : 'text/event-stream' } }));
  try {
    await executeLlmProviderAttempt({ projectRoot: f.projectRoot, registry, plan: built, options: options(), capabilityRequest: { requiresImages: true }, attemptContext: { sourceSessionId: SESSION, invocationSessionId: SESSION, inputId: options().inputId, purpose: 'primary', attemptIndex: 0 } });
    throw new Error('Expected terminal failure');
  } catch (error) {
    if (!(error instanceof ProviderTurnFailure) || !(error.originalFailure instanceof LlmRequestError)) throw error;
    expect(error.originalFailure.failure).toMatchObject({ kind: 'input_context_exhausted', status: 200 });
    expect(JSON.stringify({ failure: error.originalFailure.failure, attempts: error.provider_exchanges })).not.toMatch(/data:image|base64|\/images\//);
  }
  fetch.mockRestore();
});

it('charges each emitted occurrence, raster edges and ordinary base64 text without special subtraction', async () => {
  expect(rasterReservation({ width: 1024, height: 1024 })).toBe(2048);
  expect(rasterReservation({ width: 1600, height: 1600 })).toBe(5000);
  expect(rasterReservation({ width: 2048, height: 2048 })).toBe(8192);
  expect(rasterReservation({ width: 2000, height: 20_000 })).toBe(78_750);
  const f = await fixture(33, 65);
  const image = await materializeConversationImage(f.projectRoot, SESSION, f.descriptor);
  const input = buildSummaryRequestInput({
    candidate,
    sourceSessionId: SESSION,
    instruction: 'summarize',
    items: [{ label: 'images', role: 'user', content: image.dataUrl, contentBlocks: [{ type: 'image', image }, { type: 'image', image }] }],
  });
  const built = plan(input.providerConversation);
  expect(built.request.imageCount).toBe(2);
  expect(built.request.estimatedWireInputTokens).toBe(
    Math.ceil(Buffer.byteLength(built.request.serializedBody) / 4) + 24,
  );
  expect(imageAccountingBytes(f.descriptor)).toBe(encodedPartBytes(f.descriptor) + 48);
  expect(imageEstimatedTokens(f.descriptor)).toBe(
    Math.ceil(encodedPartBytes(f.descriptor) / 4) + 12,
  );
});

it.each([
  [1024, 2048],
  [1600, 5000],
  [2048, 8192],
])(
  'charges a selected %i-square raster plus complete wire bytes, never a model-specific billing formula',
  async (dimension, reservation) => {
    const f = await fixture(dimension, dimension);
    const projection = await materializeProviderConversation(f.projectRoot, f.projection);
    for (const protocol of ['openai-responses', 'openai-codex-backend'] as const) {
      const built = plan(projection, protocol);
      expect(built.request.estimatedWireInputTokens).toBe(
        Math.ceil(Buffer.byteLength(built.request.serializedBody) / 4) + reservation!,
      );
    }
  },
);

it('wire cap is a local capacity verdict and summary refusal even with ample token capacity', async () => {
  const f = await fixture(1, 1);
  const image = {
    descriptor: f.descriptor,
    dataUrl: `data:image/png;base64,${'a'.repeat(MAX_IMAGE_REQUEST_BYTES)}`,
  };
  const input = buildSummaryRequestInput({
    candidate,
    sourceSessionId: SESSION,
    instruction: 'summary',
    items: [{ label: 'atomic', role: 'user', content: 'observation', contentBlocks: [{ type: 'image', image }] }],
  });
  const built = plan(input.providerConversation);
  const capabilities = { ...built.capabilities, contextWindowTokens: 100_000_000 };
  expect(
    classifyCandidateLocalAdmission({
      capabilities,
      match: { supported: true },
      plan: built,
      limits: { contextUtilizationFraction: 0.8, requestedCompletionTokens: 2000 },
    }).kind,
  ).toBe('projection_too_large');
  expect(
    admitSummaryRequest({
      serialization: {
        serializedRequest: built.request.serializedBody,
        requestSha256: built.request.requestHash,
        estimatedInputTokens: built.request.estimatedWireInputTokens,
        imageCount: built.request.imageCount,
      },
      contextWindowTokens: 100_000_000,
      maxOutputTokens: 128_000,
      contextUtilizationFraction: 0.8,
    }).kind,
  ).toBe('too_large');
});

it.each(['local_exact_admission', 'preventive', 'authoritative_context_recovery'] as const)(
  'F2: %s qualifies actual image reduction despite metadata growth, publishes and admits smaller bytes',
  async (strategy) => {
    const f = await fixture();
    const rejected = await materializeProviderConversation(f.projectRoot, f.projection);
    const summary = 'Visual observation: dark translucent screenshot. '.repeat(60);
    const seen: string[] = [];
    const result = await compact({
      strategy,
      conversations: { projectRoot: f.projectRoot },
      input: invocation(rejected),
      summarizerProvider: summaryProvider(f.projectRoot, summary, seen),
      signal: new AbortController().signal,
      progress: noCompactionProgress,
    });
    expect(result.kind).toBe('compacted');
    if (result.kind !== 'compacted') throw new Error('Expected image reduction.');
    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0]!.split(',')[1]!, 'base64')).toEqual(f.bytes);
    const tupleBytes = (projection: ProviderConversationProjection) =>
      Buffer.byteLength(
        JSON.stringify(
          projection.messages.map((item) =>
            item.kind === 'synthetic_context'
              ? [item.kind, item.origin, item.block_identity, item.role, item.content]
              : [item.id, item.role, item.kind, item.content],
          ),
        ),
      );
    expect(tupleBytes(result.providerConversation)).toBeGreaterThan(tupleBytes(rejected));
    expect(composedProviderConversationAccountingBytes(result.providerConversation)).toBeLessThan(
      composedProviderConversationAccountingBytes(rejected),
    );
    expect(estimateProviderConversationTokens(result.providerConversation)).toBeLessThan(
      estimateProviderConversationTokens(rejected),
    );
    const smaller = plan(result.providerConversation);
    expect(Buffer.byteLength(smaller.request.serializedBody)).toBeLessThan(
      Buffer.byteLength(plan(rejected).request.serializedBody),
    );
    expect(
      classifyCandidateLocalAdmission({
        capabilities: smaller.capabilities,
        match: { supported: true },
        plan: smaller,
        limits: { contextUtilizationFraction: 0.8, requestedCompletionTokens: 2000 },
      }).kind,
    ).toBe('admitted');
    // Covered pixels are no longer consumed, even when the exact body is absent.
    unlinkSync(conversationImageFile(f.projectRoot, SESSION, f.descriptor.id));
    const reopened = await materializeProviderConversation(
      f.projectRoot,
      providerConversationProjection(readConversation(f.projectRoot, SESSION), []),
    );
    expect(reopened.messages.flatMap(providerItemImageDescriptors)).toHaveLength(0);
  },
);

it('uses the exact source session and fences cancellation after asynchronous summary image materialization', async () => {
  const f = await fixture(33, 65);
  const image = await materializeConversationImage(f.projectRoot, SESSION, f.descriptor);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const base = summaryProvider(f.projectRoot, 'summary', []);
  const materializeImage = jest.fn<SummarizerProviderPort['materializeImage']>(() => new Promise(resolve => { release = () => resolve(image); entered(); }));
  const serializeSummaryRequest = jest.fn(base.serializeSummaryRequest);
  const completeTurn = jest.fn(base.completeTurn);
  const controller = new AbortController();
  const accumulator = createSequentialRefineAccumulator({ conversation: f.conversation, inheritedHistory: null, preparedBlocks: [], summarizerProvider: { ...base, materializeImage, serializeSummaryRequest, completeTurn }, budget: { contextUtilizationFraction: 0.8 }, signal: controller.signal, progress: noCompactionProgress });
  const pending = accumulator.materializeThrough(f.conversation.sourceRows.length);
  await started;
  expect(materializeImage).toHaveBeenCalledWith(SESSION, f.descriptor);
  const reason = new Error('summary cancelled during native materialization');
  controller.abort(reason);
  release();
  await expect(pending).rejects.toBe(reason);
  expect(serializeSummaryRequest).not.toHaveBeenCalled();
  expect(completeTurn).not.toHaveBeenCalled();
});

it('atomic visual summary refuses without splitting call/result or substituting descriptor-only text', async () => {
  const f = await fixture();
  const seen: string[] = [];
  const provider = {
    ...summaryProvider(f.projectRoot, 'summary', seen),
    contextWindowTokens: 3000,
  };
  const accumulator = createSequentialRefineAccumulator({
    conversation: f.conversation,
    inheritedHistory: null,
    preparedBlocks: [],
    summarizerProvider: provider,
    budget: { contextUtilizationFraction: 0.8 },
    signal: new AbortController().signal,
    progress: noCompactionProgress,
  });
  await expect(
    accumulator.materializeThrough(f.conversation.sourceRows.length),
  ).rejects.toBeInstanceOf(SummaryConstructionLimitError);
  expect(seen).toHaveLength(0);
});

it('keeps source-session ownership for retained images and rejects missing selected bodies at use', async () => {
  const f = await fixture();
  const projection = await materializeProviderConversation(f.projectRoot, f.projection);
  expect(composedProviderConversationAccountingBytes(projection)).toBe(
    composedProviderConversationAccountingBytes(f.projection),
  );
  expect(estimateProviderConversationTokens(projection)).toBe(
    estimateProviderConversationTokens(f.projection),
  );
  unlinkSync(conversationImageFile(f.projectRoot, SESSION, f.descriptor.id));
  expect(
    providerConversationProjection(readConversation(f.projectRoot, SESSION), []).messages,
  ).toHaveLength(f.projection.messages.length);
  await expect(materializeProviderConversation(f.projectRoot, f.projection)).rejects.toThrow();
  expect(capabilityRequestForTools(['view_image']).requiresImages).toBe(true);
});

it.each(['gpt-6.1-sol', 'gpt-6-astra'])(
  'retains exact admitted bytes through %s failover and repeated dispatch without reopening selected pixels',
  async (model) => {
    const f = await fixture(33, 65);
    const a = { provider: 'image-a', model, account: null };
    const b = { provider: 'image-b', model, account: null };
    const registry = invocationProviderRegistry([a, b], {
      'image-a': { transportProtocol: 'openai-responses' },
      'image-b': { transportProtocol: 'openai-responses' },
    });
    const service = new InvocationService({
      projectRoot: f.projectRoot,
      registry,
      candidateAvailability: new MemoryCandidateAvailability(),
      freshness: NO_FRESHNESS_EFFECTS,
    });
    const provider = createInvocationServiceProvider(service, f.projectRoot);
    const input = {
      ...invocation(f.projection),
      routePass: { kind: 'ordinary' as const, candidateChain: [a, b] },
    };
    const admission = await provider.preparePrimaryRequestAdmission(
      input,
      new AbortController().signal,
    );
    expect(admission.bindings.capabilityRequest.requiresImages).toBe(true); // tool was removed, retained pixels still require vision
    if (admission.kind !== 'admitted') throw new Error('Expected image admission.');
    unlinkSync(conversationImageFile(f.projectRoot, SESSION, f.descriptor.id));
    const success = () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'visual answer' }] }],
        }),
        { status: 200 },
      );
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockImplementation(async () => success());
    const completion = await provider.executeAdmittedWithRecovery(
      admission,
      new AbortController().signal,
    );
    expect(completion.result.kind).toBe('message');
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [index, verdict] of admission.candidates.entries()) {
      if (verdict.kind !== 'admitted') throw new Error('Expected both models admitted.');
      expect(fetch.mock.calls[index]![1]!.body).toBe(verdict.plan.request.serializedBody);
      expect(
        createHash('sha256').update(String(fetch.mock.calls[index]![1]!.body)).digest('hex'),
      ).toBe(verdict.plan.request.requestHash);
    }
    const retained = admission.candidates[1]!;
    if (retained.kind !== 'admitted') throw new Error('Expected retained plan.');
    await executeLlmProviderAttempt({
      projectRoot: f.projectRoot,
      registry,
      plan: retained.plan,
      options: admission.execution.options,
      capabilityRequest: admission.execution.capabilityRequest,
      attemptContext: { sourceSessionId: admission.bindings.sourceSessionId, invocationSessionId: admission.bindings.sessionId, inputId: admission.bindings.inputId, purpose: 'primary', attemptIndex: 2 },
    });
    expect(fetch.mock.calls[2]![1]!.body).toBe(fetch.mock.calls[1]![1]!.body);
  },
);

it.each(['gpt-6.1-sol', 'gpt-6-astra'])(
  'refuses %s Chat image/tool candidates before dispatch, preserves ordinary text-only Chat',
  async (model) => {
    const f = await fixture(1, 1);
    const selected = { ...candidate, model };
    const registry = invocationProviderRegistry([selected]);
    const service = new InvocationService({
      projectRoot: f.projectRoot,
      registry,
      candidateAvailability: new MemoryCandidateAvailability(),
      freshness: NO_FRESHNESS_EFFECTS,
    });
    const provider = createInvocationServiceProvider(service, f.projectRoot);
    const fetch = jest.spyOn(globalThis, 'fetch');
    const signal = new AbortController().signal;
    const input = {
      ...invocation(f.projection),
      routePass: { kind: 'ordinary' as const, candidateChain: [selected] },
    };
    const imageAdmission = await provider.preparePrimaryRequestAdmission(input, signal);
    expect(imageAdmission.kind).toBe('local_admission_failed');
    expect(imageAdmission.candidates[0]).toMatchObject({
      kind: 'candidate_ineligible',
      reason: { kind: 'capability_mismatch', reasons: ['unsupported_image_input'] },
    });
    const textInput: PreparedLlmInvocationInput = {
      ...input,
      providerConversation: { sourceSessionId: null, messages: [] },
    };
    expect(
      (
        await provider.preparePrimaryRequestAdmission(
          { ...textInput, capabilityRequest: { requiresTools: true } },
          signal,
        )
      ).kind,
    ).toBe('local_admission_failed');
    const textAdmission = await provider.preparePrimaryRequestAdmission(textInput, signal);
    expect(textAdmission.kind).toBe('admitted');
    if (textAdmission.kind !== 'admitted' || textAdmission.candidates[0]!.kind !== 'admitted')
      throw new Error('Text Chat must fit.');
    expect(textAdmission.candidates[0]!.plan.request.body).not.toHaveProperty('temperature');
    expect(textAdmission.candidates[0]!.plan.request.body).not.toHaveProperty('reasoning');
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('captures failed real image wire bytes by hash but omits pixels before private diagnostic publication', async () => {
  const f = await fixture(33, 65);
  const activation = randomUUID();
  const selected = { provider: 'diagnostic-image', account: null, model: 'gpt-6-astra' };
  const registry = invocationProviderRegistry([selected], { 'diagnostic-image': { transportProtocol: 'openai-responses' } });
  const service = new InvocationService({ projectRoot: f.projectRoot, registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS, failedProviderDiagnostics: activation });
  const provider = createInvocationServiceProvider(service, f.projectRoot);
  const signal = new AbortController().signal;
  const admitted = await provider.preflightPinnedContentPolicyRequest({ ...invocation(f.projection), routePass: { kind: 'pinned-content-policy-retry', candidate: selected } }, signal);
  if (admitted.kind !== 'admitted') throw new Error('Expected image admission.');
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":{"code":"content_filter","message":"synthetic refusal"}}', { status: 400 }));
  await expect(provider.executePinnedContentPolicyRequest(admitted, { attemptIndex: 1 }, signal)).rejects.toMatchObject({ originalFailure: { failure: { kind: 'content_policy' } } });
  const raw = String(fetch.mock.calls[0]![1]!.body);
  expect(raw).toBe(admitted.plan.request.serializedBody); expect(raw).toContain('data:image/png;base64,');
  const directory = join(f.projectRoot, '.saivage/diagnostics/failed-provider-requests', activation);
  const names = readdirSync(directory).filter(name => name.endsWith('.json')); expect(names).toHaveLength(1);
  const file = readFileSync(join(directory, names[0]!), 'utf8'); const dump = JSON.parse(file);
  expect(dump).toMatchObject({ raw_request_sha256: createHash('sha256').update(raw).digest('hex'), body_disposition: 'redacted', counts: { images: 1 }, attempt_index: 1 });
  expect(file).not.toContain('data:image/png;base64,'); expect(file).not.toContain(f.bytes.toString('base64'));
  expect(dump.stored_body_sha256).toBe(createHash('sha256').update(dump.stored_body).digest('hex'));
  const output = JSON.parse(dump.stored_body).input.find((item: { type: string }) => item.type === 'function_call_output');
  expect(output.output[1]).toBe('[OMITTED_IMAGE]');
});

it('prepares a pinned image retry once and dispatches its exact admitted bytes after the selected file is removed', async () => {
  const f = await fixture(33, 65);
  const selected = { provider: 'pinned-image', account: null, model: 'gpt-6-astra' };
  const registry = invocationProviderRegistry([selected], { 'pinned-image': { transportProtocol: 'openai-responses' } });
  const service = new InvocationService({ projectRoot: f.projectRoot, registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
  const provider = createInvocationServiceProvider(service, f.projectRoot);
  const input = { ...invocation(f.projection), routePass: { kind: 'pinned-content-policy-retry' as const, candidate: selected } };
  const signal = new AbortController().signal;
  const admitted = await provider.preflightPinnedContentPolicyRequest(input, signal);
  if (admitted.kind !== 'admitted') throw new Error('Expected pinned image admission.');
  expect(admitted.capabilityRequest.requiresImages).toBe(true);
  expect(admitted.plan.request.imageCount).toBe(1);
  unlinkSync(conversationImageFile(f.projectRoot, SESSION, f.descriptor.id));
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] }), { status: 200 }));
  await provider.executePinnedContentPolicyRequest(admitted, { attemptIndex: 0 }, signal);
  expect(fetch.mock.calls[0]![1]!.body).toBe(admitted.plan.request.serializedBody);
  const output = (JSON.parse(String(fetch.mock.calls[0]![1]!.body)).input as Array<Record<string, unknown>>).find(item => item.type === 'function_call_output')!;
  const image = (output.output as Array<Record<string, unknown>>)[1]!;
  expect(Buffer.from(String(image.image_url).split(',')[1]!, 'base64')).toEqual(f.bytes);
});

it('retains a recent atomic image tail, rejects changed source descriptor freshness, and folds inherited summary without reopening covered pixels', async () => {
  const f = await fixture(33, 65);
  const prefix: AgentMessage = {
    ...rows(f.descriptor)[0]!,
    id: 'older-text',
    role: 'user',
    kind: 'text',
    content: 'prior notes '.repeat(1500),
    context_policy: TEXT_ROW_POLICY,
  };
  // Separate fixture with a long older prefix, then the newest visual bundle.
  const projectRoot = root();
  const descriptor = publishConversationImage(projectRoot, SESSION, f.bytes, {
    width: 33,
    height: 65,
  });
  const originalRows = rows(descriptor);
  appendConversationBatch({ projectRoot }, [originalRows[0]!, prefix, ...originalRows.slice(1)]);
  const projection = providerConversationProjection(readConversation(projectRoot, SESSION), []);
  const seen: string[] = [];
  const provider = summaryProvider(projectRoot, 'prior summary', seen);
  const first = await compact({
    strategy: 'authoritative_context_recovery',
    conversations: { projectRoot },
    input: invocation(await materializeProviderConversation(projectRoot, projection), 0.01),
    summarizerProvider: provider,
    signal: new AbortController().signal,
    progress: noCompactionProgress,
  });
  if (first.kind !== 'compacted') throw new Error('Expected prefix compaction.');
  expect(first.providerConversation.messages.flatMap(providerItemImageDescriptors)).toEqual([
    descriptor,
  ]);
  expect(seen).toHaveLength(0);
  const changed = structuredClone(first.providerConversation);
  if (changed.sourceSessionId === null) throw new Error('Expected retained source.');
  const result = changed.messages.find((item) => item.kind === 'tool_result')!;
  const parsed = JSON.parse(result.content);
  parsed.content[0].image.sha256 = 'f'.repeat(64);
  changed.messages[changed.messages.indexOf(result)] = {
    ...result,
    content: canonicalJson(parsed),
  };
  await expect(
    compact({
      strategy: 'local_exact_admission',
      conversations: { projectRoot },
      input: invocation(changed),
      summarizerProvider: provider,
      signal: new AbortController().signal,
      progress: noCompactionProgress,
    }),
  ).rejects.toThrow(/stale/);
  const second = await compact({
    strategy: 'local_exact_admission',
    conversations: { projectRoot },
    input: invocation(first.providerConversation),
    summarizerProvider: provider,
    signal: new AbortController().signal,
    progress: noCompactionProgress,
  });
  expect(second.kind).toBe('compacted');
  expect(seen).toHaveLength(1);
  unlinkSync(conversationImageFile(projectRoot, SESSION, descriptor.id));
  await expect(
    materializeProviderConversation(
      projectRoot,
      providerConversationProjection(readConversation(projectRoot, SESSION), []),
    ),
  ).resolves.toBeDefined();
});
