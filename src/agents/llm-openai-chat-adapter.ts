import { COPILOT_CLIENT_IDENTITY } from './copilot-client-identity.js';
import {
  parseToolCallMessageForModel,
  providerConversationRequiresImages,
  assertProviderItemImageMaterialized,
  LlmRequestError,
  type Candidate,
  type LlmCompleteOptions,
  type LlmCompleteResult,
  type ProviderConversationItem,
  type ProviderConversationProjection,
  type ToolCall,
  type LlmProtocolAdapter,
} from '../contracts/index.js';
import { classifyHttpFailure, httpFailureDiagnosticMetadata } from './llm-failure-classifiers.js';
import { extractChatUsage } from './llm-usage.js';
import {
  serializeToolsForChat,
  type WireToolDefinitionChat,
} from './tool-definition-serializer.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens: number;
  stream: false;
  tools?: readonly WireToolDefinitionChat[];
  tool_choice?: 'auto';
  parallel_tool_calls?: false;
}
interface ChatCompletionResponse {
  choices: Array<{
    message?: { content: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
}

export const openAIChatAdapter: LlmProtocolAdapter = {
  credentialRequirement: 'standard',
  buildRequestBody: ({ candidate, systemPrompt, providerConversation, options }) =>
    buildOpenAIChatRequest(
      candidate,
      systemPrompt,
      providerConversation,
      options,
    ) as unknown as Record<string, unknown>,
  deriveWire(candidate, transport, body, options) {
    const baseUrl = transport.baseUrl.replace(/\/+$/, '');
    const isCopilot = candidate.provider === 'github-copilot';
    const endpoint =
      isCopilot || /\/v1$/.test(baseUrl)
        ? `${baseUrl}/chat/completions`
        : `${baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Connection: 'close',
    };
    if (isCopilot) Object.assign(headers, COPILOT_CLIENT_IDENTITY);
    if (transport.apiKey) headers.Authorization = `Bearer ${transport.apiKey}`;
    const request = body as unknown as ChatCompletionRequest;
    return {
      endpoint,
      headers,
      transport: 'generic',
      requestParams: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        max_tokens: options.max_tokens,
        stream: false,
        offered_tools_count: request.tools?.length ?? 0,
      },
    };
  },
  classifyHttpFailure(candidate, response, bodyText) {
    const failure = classifyHttpFailure('chat', response, bodyText, {
      provider: candidate.provider,
      model: candidate.model,
    });
    return new LlmRequestError(failure, httpFailureDiagnosticMetadata(bodyText));
  },
  async parseSuccess(candidate, response, _options, consumption) {
    const rawText = await consumption.readText(response);
    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(rawText) as ChatCompletionResponse;
    } catch (error) {
      throw new LlmRequestError({
        kind: 'parse_error',
        provider: candidate.provider,
        message: `Failed to parse chat completions response: ${error instanceof Error ? error.message : String(error)}`,
        bodyPreview: rawText.slice(0, 500),
      });
    }
    if (!parsed.choices?.length)
      throw new LlmRequestError({
        kind: 'parse_error',
        provider: candidate.provider,
        message: 'Chat completions response contains no choices',
        bodyPreview: rawText.slice(0, 500),
      });
    const choice = parsed.choices[0]!;
    const toolCalls = choice.message?.tool_calls ?? [];
    const usage = extractChatUsage(parsed.usage, candidate.provider);
    const result: LlmCompleteResult = toolCalls.length
      ? { kind: 'tool_calls', tool_calls: toolCalls, usage }
      : { kind: 'message', content: choice.message?.content ?? '', usage };
    return { result, finishReason: choice.finish_reason };
  },
};

function buildOpenAIChatRequest(
  candidate: Candidate,
  systemPrompt: string,
  providerConversation: ProviderConversationProjection,
  opts: LlmCompleteOptions,
): ChatCompletionRequest {
  if (providerConversationRequiresImages(providerConversation))
    throw new Error('Chat image input is unsupported.');
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...providerConversation.messages
      .filter((m) => m.kind !== 'provider_private')
      .map((m): ChatMessage => {
        assertProviderItemImageMaterialized(m);
        if (m.kind === 'synthetic_context') return { role: m.role, content: m.content };
        if (m.role === 'assistant' && m.kind === 'tool_call') {
          const call = parseToolCallMessageForModel(JSON.parse(m.content));
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              },
            ],
          };
        }
        if (m.role === 'tool')
          return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id };
        return { role: toChatRole(m.role), content: m.content };
      }),
  ];
  const body: ChatCompletionRequest = {
    model: candidate.model,
    messages,
    ...(candidate.model === 'gpt-6.1-sol' || candidate.model === 'gpt-6-astra'
      ? {}
      : { temperature: opts.temperature }),
    max_tokens: opts.max_tokens,
    stream: false,
  };
  if (opts.tools.length) {
    body.tools = serializeToolsForChat(opts.tools);
    body.tool_choice = opts.tool_choice;
    body.parallel_tool_calls = false;
  }
  return body;
}

function toChatRole(role: ProviderConversationItem['role']): ChatMessage['role'] {
  switch (role) {
    case 'system':
      return 'system';
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return 'tool';
  }
}
