import {
  LlmRequestError,
  type Candidate,
  type EffectiveProviderCapabilities,
  type LlmCompleteOptions,
  type ProviderConversationProjection,
  type LlmProtocolAdapter,
  type ImageDescriptor,
} from '../contracts/index.js';
import { classifyHttpFailure } from './llm-failure-classifiers.js';
import { responsesInputFromProviderConversation } from './llm-openai-responses-mapper.js';
import { responsesProducerAccountId } from './llm-openai-responses-account.js';
import { parseOpenAIResponsesJson } from './llm-openai-responses-parser.js';
import {
  serializeToolsForCodex,
  type WireToolDefinitionCodex,
} from './tool-definition-serializer.js';

interface OpenAIResponsesRequest {
  model: string;
  instructions: string;
  input: Record<string, unknown>[];
  store: false;
  include: ['reasoning.encrypted_content'];
  stream: false;
  max_output_tokens: number;
  tools?: readonly WireToolDefinitionCodex[];
  tool_choice?: 'auto';
  parallel_tool_calls?: false;
  reasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' };
}
export const openAIResponsesAdapter: LlmProtocolAdapter = {
  credentialRequirement: 'openai_responses_api_key',
  buildRequestBody: ({
    candidate,
    systemPrompt,
    providerConversation,
    options,
    capabilities,
    onImageEmitted,
  }) =>
    buildOpenAIResponsesRequest(
      candidate,
      systemPrompt,
      providerConversation,
      options,
      capabilities,
      onImageEmitted,
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
  classifyHttpFailure(candidate, response, bodyText, _body, _options, imageBearing) {
    return new LlmRequestError(
      classifyHttpFailure('responses', response, bodyText, {
        suppressBodyPreview: imageBearing,
        provider: candidate.provider,
        model: candidate.model,
      }),
    );
  },
  async parseSuccess(candidate, response, options, consumption, imageBearing) {
    const context = {
      provider: candidate.provider,
      producerAccountId: responsesProducerAccountId(candidate),
      model: candidate.model,
      sourceInputId: options.inputId,
      responseStatus: response.status,
      suppressBodyPreview: imageBearing,
    };
    const parsed = parseOpenAIResponsesJson(await consumption.readText(response), context);
    return {
      result: parsed.result,
      privateContext: parsed.privateContext,
      finishReason: parsed.responseStatus,
    };
  },
};
function buildOpenAIResponsesRequest(
  candidate: Candidate,
  systemPrompt: string,
  providerConversation: ProviderConversationProjection,
  opts: LlmCompleteOptions,
  capabilities?: Pick<EffectiveProviderCapabilities, 'responsesReasoning'>,
  onImageEmitted?: (descriptor: ImageDescriptor) => void,
): OpenAIResponsesRequest {
  const body: OpenAIResponsesRequest = {
    model: candidate.model,
    instructions: systemPrompt,
    input: responsesInputFromProviderConversation(
      providerConversation,
      responsesProducerAccountId(candidate),
      onImageEmitted,
    ),
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: opts.max_tokens,
    stream: false,
  };
  if (opts.tools.length) {
    body.tools = serializeToolsForCodex(opts.tools);
    body.tool_choice = opts.tool_choice;
    body.parallel_tool_calls = false;
  }
  if (capabilities?.responsesReasoning) body.reasoning = capabilities.responsesReasoning;
  return body;
}
