import type { Candidate } from '../contracts/provider-candidate.js';
import type { EffectiveProviderCapabilities } from './provider-capabilities.js';
import type { LlmCompleteOptions, ProviderConversationProjection } from './llm-contracts.js';
import { LlmRequestError } from './llm-errors.js';
import { classifyHttpFailure } from './llm-failure-classifiers.js';
import { responsesInputFromProviderConversation } from './llm-openai-responses-mapper.js';
import {
  parseOpenAIResponsesJson,
  readOpenAIResponsesStream,
} from './llm-openai-responses-parser.js';
import {
  serializeToolsForResponses,
  type WireToolDefinitionResponses,
} from './tool-definition-serializer.js';
import type { LlmProtocolAdapter } from './llm-protocol-adapter.js';

interface OpenAIResponsesRequest {
  model: string;
  instructions: string;
  input: Record<string, unknown>[];
  store: false;
  include: ['reasoning.encrypted_content'];
  stream: boolean;
  max_output_tokens: number;
  tools?: readonly WireToolDefinitionResponses[];
  tool_choice?: 'auto';
  parallel_tool_calls?: false;
  reasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' };
}
export const openAIResponsesAdapter: LlmProtocolAdapter = {
  credentialRequirement: 'openai_responses_api_key',
  buildRequestBody: ({ candidate, systemPrompt, providerConversation, options, capabilities }) =>
    buildOpenAIResponsesRequest(
      candidate,
      systemPrompt,
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
    if (request.stream) headers.Accept = 'text/event-stream';
    return {
      endpoint,
      headers,
      transport: 'openai-responses',
      streaming: request.stream,
      requestParams: {
        stream: request.stream,
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
    const parsed = options.stream
      ? response.body
        ? await readOpenAIResponsesStream(response.body, context)
        : (() => {
            throw new LlmRequestError({
              kind: 'server_transient',
              provider: candidate.provider,
              status: response.status,
              message: 'OpenAI Responses streaming response has no body',
            });
          })()
      : parseOpenAIResponsesJson(await response.text(), context);
    return {
      result: parsed.result,
      privateContext: parsed.privateContext,
      finishReason: parsed.responseStatus,
    };
  },
};
export function buildOpenAIResponsesRequest(
  candidate: Candidate,
  systemPrompt: string,
  providerConversation: ProviderConversationProjection,
  opts: LlmCompleteOptions,
  capabilities?: Pick<EffectiveProviderCapabilities, 'responsesReasoning'>,
): OpenAIResponsesRequest {
  const systemContext = providerConversation.messages
    .filter((m) => m.role === 'system' && (m.kind === 'model_recovered' || m.kind === 'text'))
    .map((m) => m.content);
  const body: OpenAIResponsesRequest = {
    model: candidate.model,
    instructions: [systemPrompt, ...systemContext].join('\n\n--- system context ---\n'),
    input: responsesInputFromProviderConversation(providerConversation),
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: opts.max_tokens ?? 4096,
    stream: opts.stream === true,
  };
  if (opts.tools.length) {
    body.tools = serializeToolsForResponses(opts.tools);
    body.tool_choice = opts.tool_choice;
    body.parallel_tool_calls = false;
  }
  if (capabilities?.responsesReasoning) body.reasoning = capabilities.responsesReasoning;
  return body;
}
