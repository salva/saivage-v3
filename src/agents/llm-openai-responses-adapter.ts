import type { Candidate } from '../contracts/provider-candidate.js';
import type { EffectiveProviderCapabilities } from './provider-capabilities.js';
import type { LlmCompleteOptions, ProviderConversationProjection } from './llm-contracts.js';
import { LlmRequestError } from '../contracts/llm-failure.js';
import { classifyHttpFailure } from './llm-failure-classifiers.js';
import { responsesInputFromProviderConversation } from './llm-openai-responses-mapper.js';
import { parseOpenAIResponsesJson } from './llm-openai-responses-parser.js';
import {
  serializeToolsForResponses,
  type WireToolDefinitionResponses,
} from './tool-definition-serializer.js';
import type { LlmProtocolAdapter } from './llm-protocol-adapter.js';
import type { ContextBlock } from '../runtime/actors/context/index.js';

interface OpenAIResponsesRequest {
  model: string;
  instructions: string;
  input: Record<string, unknown>[];
  store: false;
  include: ['reasoning.encrypted_content'];
  stream: false;
  max_output_tokens: number;
  tools?: readonly WireToolDefinitionResponses[];
  tool_choice?: 'auto';
  parallel_tool_calls?: false;
  reasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' };
}
export const openAIResponsesAdapter: LlmProtocolAdapter = {
  credentialRequirement: 'openai_responses_api_key',
  buildRequestBody: ({ candidate, instructionText, dynamicBlocks, providerConversation, options, capabilities }) =>
    buildOpenAIResponsesRequest(
      candidate,
      instructionText,
      dynamicBlocks,
      providerConversation,
      options,
      capabilities,
    ) as unknown as Record<string, unknown>,
  deriveWire(candidate, transport, body) {
    if (!transport.apiKey)
      throw new LlmRequestError({
        kind: 'auth_permanent',
        provider: candidate.provider,
        status: 401,
        message: 'OpenAI Responses provider requires an API key',
      });
    const baseUrl = transport.baseUrl.replace(/\/+$/, '');
    const endpoint = /\/v1$/.test(baseUrl) ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
    const request = body as unknown as OpenAIResponsesRequest;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Connection: 'close',
      Authorization: `Bearer ${transport.apiKey}`,
    };
    return {
      endpoint,
      headers,
      transport: 'openai-responses',
      requestParams: {
        stream: false,
        offered_tools_count: request.tools?.length ?? 0,
        max_output_tokens: request.max_output_tokens,
        include: request.include,
        store: request.store,
        reasoning_keys: request.reasoning ? Object.keys(request.reasoning).sort() : [],
      },
    };
  },
  classifyHttpFailure(candidate, response, bodyText) {
    return new LlmRequestError(
      classifyHttpFailure('responses', response, bodyText, {
        provider: candidate.provider,
        model: candidate.model,
      }),
    );
  },
  async parseSuccess(candidate, response, options) {
    const context = {
      provider: candidate.provider,
      model: candidate.model,
      sourceInputId: options.inputId,
      responseStatus: response.status,
    };
    const parsed = parseOpenAIResponsesJson(await response.text(), context);
    return {
      result: parsed.result,
      privateContext: parsed.privateContext,
      finishReason: parsed.responseStatus,
    };
  },
};
export function buildOpenAIResponsesRequest(
  candidate: Candidate,
  instructionText: string,
  dynamicBlocks: readonly ContextBlock[],
  providerConversation: ProviderConversationProjection,
  opts: LlmCompleteOptions,
  capabilities?: Pick<EffectiveProviderCapabilities, 'responsesReasoning'>,
): OpenAIResponsesRequest {
  const systemContext = [...dynamicBlocks.filter((block) => block.role === 'system').map((block) => block.content), ...providerConversation.messages
    .filter((m) => m.role === 'system' && (m.kind === 'model_recovered' || m.kind === 'text'))
    .map((m) => m.content)];
  const dynamicInput = dynamicBlocks.filter((block) => block.role !== 'system').map((block) => block.role === 'tool'
    ? { type: 'function_call_output', call_id: block.id, output: block.content }
    : { role: block.role === 'assistant' ? 'assistant' : 'user', content: [{ type: block.role === 'assistant' ? 'output_text' : 'input_text', text: block.content }] });
  const body: OpenAIResponsesRequest = {
    model: candidate.model,
    instructions: [instructionText, ...systemContext].join('\n\n--- system context ---\n'),
    input: [...dynamicInput, ...responsesInputFromProviderConversation(providerConversation)],
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: opts.max_tokens,
    stream: false,
  };
  if (opts.tools.length) {
    body.tools = serializeToolsForResponses(opts.tools);
    body.tool_choice = opts.tool_choice;
    body.parallel_tool_calls = false;
  }
  if (capabilities?.responsesReasoning) body.reasoning = capabilities.responsesReasoning;
  return body;
}
