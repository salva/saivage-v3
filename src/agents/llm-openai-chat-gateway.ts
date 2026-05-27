import type { AgentMessage } from '../schemas/index.js';
import type { Candidate } from './provider.js';
import type { LlmCompleteOptions, LlmCompleteResult, ToolCall, ToolDefinition } from './llm-contracts.js';
import { parsePersistedToolCalls } from './llm-contracts.js';
import { LlmParseError, LlmServerError, normalizeLlmTransportError, handleLlmHttpError } from './llm-errors.js';
import { beginRecordedExchange, recordResponseError, teeStreamForRecorder } from './llm-recording.js';
import { readOpenAIChatStream } from './llm-stream-parser.js';

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
  tools?: ToolDefinition[];
  tool_choice?: unknown;
}

interface ChatCompletionResponse {
  choices: Array<{
    message?: { content: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string | null;
  }>;
}

export interface OpenAIChatGatewayConfig {
  baseUrl: string;
  apiKey?: string;
}

export class OpenAIChatGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(config: OpenAIChatGatewayConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  async complete(
    candidate: Candidate,
    systemPrompt: string,
    messages: AgentMessage[],
    _sessionId: string,
    opts?: LlmCompleteOptions,
  ): Promise<LlmCompleteResult> {
    const requestBody = buildOpenAIChatRequest(candidate, systemPrompt, messages, opts);
    const url = this.chatCompletionsUrl();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...this.providerHeaders(),
    };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const handle = await beginRecordedExchange(opts?.recorder, {
      transport: 'generic',
      candidate,
      endpoint: url,
      headers,
      body: requestBody,
    });
    let recordedErr = false;
    let rawText: string | undefined;

    try {
      let response: Response;
      try {
        response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody), signal: opts?.signal });
      } catch (err) {
        if (handle) {
          recordedErr = true;
          const e = err as Error;
          await handle.recordError({ errorName: e.name, message: e.message, bodyRaw: null });
        }
        throw err;
      }

      if (!response.ok) {
        if (handle) {
          recordedErr = true;
          const errBody = await response.clone().text().catch(() => null);
          await handle.recordError({ errorName: 'LlmServerError', message: `HTTP ${response.status}`, status: response.status, bodyRaw: errBody });
        }
        await handleLlmHttpError(response, 'llm-openai-chat-gateway');
      }

      if (requestBody.stream) {
        if (!response.body) throw new LlmServerError('Streaming response has no body', response.status);
        if (handle) {
          const tee = teeStreamForRecorder(response.body);
          const result = await readOpenAIChatStream(tee.stream);
          await handle.recordResponse({ status: response.status, bodyRaw: tee.getBuffer(), bodyParsed: result });
          return result;
        }
        return await readOpenAIChatStream(response.body);
      }

      rawText = await response.text();
      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(rawText) as ChatCompletionResponse;
      } catch (err) {
        throw new LlmParseError(`Failed to parse chat completions response: ${err instanceof Error ? err.message : String(err)}`, rawText);
      }
      if (!parsed.choices || parsed.choices.length === 0) {
        throw new LlmParseError('Chat completions response contains no choices', rawText);
      }
      const choice = parsed.choices[0];
      const result: LlmCompleteResult = {
        content: choice.message?.content ?? null,
        toolCalls: choice.message?.tool_calls ?? [],
        finishReason: (choice.finish_reason as 'stop' | 'tool_calls' | 'length' | null) ?? null,
      };
      if (handle) await handle.recordResponse({ status: response.status, bodyRaw: rawText, bodyParsed: parsed });
      return result;
    } catch (err) {
      if (handle && !recordedErr) await recordResponseError(handle, err, rawText ?? null);
      throw normalizeLlmTransportError(err, 'LLM');
    }
  }

  private chatCompletionsUrl(): string {
    if (this.baseUrl.includes('githubcopilot.com')) return `${this.baseUrl}/chat/completions`;
    if (/\/v1$/.test(this.baseUrl)) return `${this.baseUrl}/chat/completions`;
    return `${this.baseUrl}/v1/chat/completions`;
  }

  private providerHeaders(): Record<string, string> {
    if (!this.baseUrl.includes('githubcopilot.com')) return {};
    return {
      'User-Agent': 'GitHubCopilotChat/0.35.0',
      'Editor-Version': 'vscode/1.107.0',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0',
      'Copilot-Integration-Id': 'vscode-chat',
    };
  }
}

export function buildOpenAIChatRequest(
  candidate: Candidate,
  systemPrompt: string,
  messages: AgentMessage[],
  opts?: LlmCompleteOptions,
): ChatCompletionRequest {
  const apiMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => {
      if (m.role === 'assistant' && m.kind === 'tool_call') {
        return { role: 'assistant' as const, content: '', tool_calls: parsePersistedToolCalls(m.content) };
      }
      if (m.role === 'tool') {
        return { role: 'tool' as const, content: m.content, tool_call_id: m.tool_call_id ?? m.id };
      }
      return { role: toChatRole(m.role), content: m.content };
    }),
  ];

  const requestBody: ChatCompletionRequest = {
    model: candidate.model,
    messages: apiMessages,
    temperature: opts?.temperature ?? 0.7,
    max_tokens: opts?.max_tokens ?? 4096,
    stream: opts?.stream ?? false,
  };
  if (opts?.tools && opts.tools.length > 0) {
    requestBody.tools = opts.tools;
    if (opts.tool_choice !== undefined) requestBody.tool_choice = opts.tool_choice;
  }
  return requestBody;
}

function toChatRole(role: string): 'system' | 'user' | 'assistant' | 'tool' {
  switch (role) {
    case 'system': return 'system';
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'tool': return 'tool';
    default: return 'user';
  }
}
