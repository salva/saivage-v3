import type { AgentMessage } from '../schemas/index.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import { parseToolCallMessageForModel } from '../contracts/persisted-tool-call.js';
import type {
  LlmCompleteOptions,
  LlmCompleteResult,
  LlmUsage,
  ProviderConversationProjection,
  ToolCall,
} from './llm-contracts.js';
import { LlmRequestError } from './llm-errors.js';
import { classifyHttpFailure } from './llm-failure-classifiers.js';
import { readOpenAIChatStream } from './llm-stream-parser.js';
import { appendFinalOutboundLlmRequestSectionSizesDiagnostic } from './llm-request-diagnostics.js';
import {
  serializeToolsForChat,
  type WireToolDefinitionChat,
} from './tool-definition-serializer.js';
import type { LlmProtocolAdapter } from './llm-protocol-adapter.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  stream: boolean;
  tools?: readonly WireToolDefinitionChat[];
  tool_choice?: 'auto';
  parallel_tool_calls?: false;
}
interface ChatCompletionResponse {
  choices: Array<{
    message?: { content: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: LlmUsage;
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
  deriveWire(_candidate, transport, body, options) {
    const baseUrl = transport.baseUrl.replace(/\/+$/, '');
    const endpoint =
      baseUrl.includes('githubcopilot.com') || /\/v1$/.test(baseUrl)
        ? `${baseUrl}/chat/completions`
        : `${baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Connection: 'close',
    };
    if (baseUrl.includes('githubcopilot.com'))
      Object.assign(headers, {
        'User-Agent': 'GitHubCopilotChat/0.35.0',
        'Editor-Version': 'vscode/1.107.0',
        'Editor-Plugin-Version': 'copilot-chat/0.35.0',
        'Copilot-Integration-Id': 'vscode-chat',
      });
    if (transport.apiKey) headers.Authorization = `Bearer ${transport.apiKey}`;
    const request = body as unknown as ChatCompletionRequest;
    return {
      endpoint,
      headers,
      transport: 'generic',
      streaming: request.stream,
      requestParams: {
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 4096,
        stream: options.stream ?? false,
        offered_tools_count: request.tools?.length ?? 0,
      },
    };
  },
  classifyHttpFailure(candidate, response, bodyText, body, options) {
    const failure = classifyHttpFailure('chat', response, bodyText, {
      provider: candidate.provider,
      model: candidate.model,
    });
    const request = body as unknown as ChatCompletionRequest;
    if (failure.kind === 'input_context_exhausted')
      failure.message = appendFinalOutboundLlmRequestSectionSizesDiagnostic(
        failure.message,
        request.messages[0]?.content ?? '',
        request.messages.slice(1).map((message) => ({
          role: message.role,
          kind: message.tool_calls ? 'tool_call' : message.role === 'tool' ? 'tool_result' : 'text',
          tool: message.tool_calls?.[0]?.function.name,
          content: message.tool_calls?.length
            ? JSON.stringify(message.tool_calls)
            : message.content,
        })),
        request.tools?.length ?? 0,
        JSON.stringify(request.tools ?? []).length,
        options,
      );
    return new LlmRequestError(failure);
  },
  async parseSuccess(candidate, response, options) {
    if (options.stream ?? false) {
      if (!response.body)
        throw new LlmRequestError({
          kind: 'server_transient',
          provider: candidate.provider,
          status: response.status,
          message: 'Streaming response has no body',
        });
      return { result: await readOpenAIChatStream(response.body) };
    }
    const rawText = await response.text();
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
    const result: LlmCompleteResult = toolCalls.length
      ? { kind: 'tool_calls', tool_calls: toolCalls, usage: parsed.usage }
      : { kind: 'message', content: choice.message?.content ?? '', usage: parsed.usage };
    return { result, finishReason: choice.finish_reason };
  },
};

export function buildOpenAIChatRequest(
  candidate: Candidate,
  systemPrompt: string,
  providerConversation: ProviderConversationProjection,
  opts: LlmCompleteOptions,
): ChatCompletionRequest {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...providerConversation.messages
      .filter((m) => m.kind !== 'provider_private')
      .map((m): ChatMessage => {
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
          return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id ?? m.id };
        return { role: toChatRole(m.role), content: m.content };
      }),
  ];
  const body: ChatCompletionRequest = {
    model: candidate.model,
    messages: sanitizeToolCallSequences(messages),
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 4096,
    stream: opts.stream ?? false,
  };
  if (opts.tools.length) {
    body.tools = serializeToolsForChat(opts.tools);
    body.tool_choice = opts.tool_choice;
    body.parallel_tool_calls = false;
  }
  return body;
}

function sanitizeToolCallSequences(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const need = new Set(message.tool_calls.map((call) => call.id));
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === 'tool') {
        const id = messages[j]!.tool_call_id;
        if (id) need.delete(id);
        j++;
      }
      if (need.size) {
        if (message.content) out.push({ role: 'assistant', content: message.content });
        continue;
      }
    }
    out.push(message);
  }
  return out;
}
function toChatRole(role: AgentMessage['role']): ChatMessage['role'] {
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
