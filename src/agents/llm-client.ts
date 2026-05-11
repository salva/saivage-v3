/**
 * LLM Client — Makes OpenAI-compatible chat completions HTTP requests.
 *
 * Supports non-streaming and streaming (SSE/NDJSON) modes with structured
 * error types for auth, rate-limit, server, timeout, and parse failures.
 *
 * Also supports tool/function calling via the OpenAI `tools` parameter.
 */

import type { Candidate } from './provider.js';
import type { AgentMessage } from '../schemas/types.js';

// ── Tool Calling Types ────────────────────────────────────────

/**
 * JSON Schema description of a single function parameter.
 */
export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

/**
 * A tool definition in OpenAI-compatible format.
 */
export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}

/**
 * A tool call returned by the LLM.
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/**
 * Structured result from a chat completions call.
 */
export interface LlmCompleteResult {
  /** The text content of the assistant's reply (null if tool_calls only). */
  content: string | null;
  /** Any tool calls the assistant wants to make. */
  toolCalls: ToolCall[];
  /** Why the model stopped generating. */
  finishReason: 'stop' | 'tool_calls' | 'length' | null;
}

// ── Options ───────────────────────────────────────────────────

export interface LlmCompleteOptions {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  /** Array of tool definitions for function calling. */
  tools?: ToolDefinition[];
  /**
   * Controls which tool is called.
   * - 'auto': model decides between generating text or calling a tool
   * - 'none': model will not call a tool
   * - 'required': model must call one of the provided tools
   * - {type:'function', function:{name:'...'}}: force a specific tool
   */
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

// ── Structured Error Types ────────────────────────────────────

export class LlmAuthError extends Error {
  public readonly code: string = 'LLM_AUTH_ERROR';
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.name = 'LlmAuthError';
    this.statusCode = statusCode;
  }
}

export class LlmRateLimitError extends Error {
  public readonly code: string = 'LLM_RATE_LIMIT_ERROR';
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 429) {
    super(message);
    this.name = 'LlmRateLimitError';
    this.statusCode = statusCode;
  }
}

export class LlmServerError extends Error {
  public readonly code: string = 'LLM_SERVER_ERROR';
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'LlmServerError';
    this.statusCode = statusCode;
  }
}

export class LlmTimeoutError extends Error {
  public readonly code: string = 'LLM_TIMEOUT_ERROR';

  constructor(message: string = 'LLM request timed out') {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmParseError extends Error {
  public readonly code: string = 'LLM_PARSE_ERROR';
  public readonly responseBody: string;

  constructor(message: string, responseBody: string) {
    super(message);
    this.name = 'LlmParseError';
    this.responseBody = responseBody;
  }
}

// ── Message Types for API ─────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
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

interface ChatCompletionChoice {
  index: number;
  message?: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
  delta?: {
    role?: string;
    content?: string;
    tool_calls?: ToolCall[];
  };
  finish_reason?: string | null;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ── Conversions ───────────────────────────────────────────────

/**
 * Convert AgentMessage roles to ChatMessage roles.
 *
 * AgentMessage uses 'tool' for tool messages; the OpenAI API also uses 'tool'.
 * We map 'system' → 'system', 'user' → 'user', 'assistant' → 'assistant',
 * 'tool' → 'tool'. All four are valid OpenAI chat roles.
 */
function toChatRole(role: string): 'system' | 'user' | 'assistant' | 'tool' {
  switch (role) {
    case 'system':
      return 'system';
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return 'tool';
    default:
      // Default to 'user' for unknown roles per API spec
      return 'user';
  }
}

// ── LlmClient ─────────────────────────────────────────────────

export class LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Send a chat completions request to the OpenAI-compatible endpoint.
   *
   * @param candidate    The resolved Candidate (provider/account/model).
   * @param systemPrompt The system-level prompt.
   * @param messages     The conversation messages so far (AgentMessage format).
   * @param sessionId    The session identifier (for logging / header use).
   * @param opts         Optional overrides for temperature, max_tokens, stream, signal, tools.
   * @returns            A structured result with content, toolCalls, and finishReason.
   */
  async complete(
    candidate: Candidate,
    systemPrompt: string,
    messages: AgentMessage[],
    sessionId: string,
    opts?: LlmCompleteOptions,
  ): Promise<LlmCompleteResult> {
    const temperature = opts?.temperature ?? 0.7;
    const maxTokens = opts?.max_tokens ?? 4096;
    const stream = opts?.stream ?? false;
    const signal = opts?.signal;
    const tools = opts?.tools;
    const toolChoice = opts?.tool_choice;

    // Build the message array: system prompt first, then conversation
    const apiMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({
        role: toChatRole(m.role),
        content: m.content,
      })),
    ];

    const requestBody: ChatCompletionRequest = {
      model: candidate.model,
      messages: apiMessages,
      temperature,
      max_tokens: maxTokens,
      stream,
    };

    // Include tools and tool_choice if provided
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      if (toolChoice !== undefined) {
        requestBody.tool_choice = toolChoice;
      }
    }

    const url = `${this.baseUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal,
      });

      if (!response.ok) {
        await this.handleHttpError(response);
      }

      if (stream) {
        if (!response.body) {
          throw new LlmServerError('Streaming response has no body', response.status);
        }
        return await this.readStream(response.body);
      }

      // Non-streaming: parse JSON
      const rawText = await response.text();
      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(rawText) as ChatCompletionResponse;
      } catch (err) {
        throw new LlmParseError(
          `Failed to parse chat completions response: ${err instanceof Error ? err.message : String(err)}`,
          rawText,
        );
      }

      if (!parsed.choices || parsed.choices.length === 0) {
        throw new LlmParseError(
          'Chat completions response contains no choices',
          rawText,
        );
      }

      const choice = parsed.choices[0];
      const finishReason = (choice.finish_reason as 'stop' | 'tool_calls' | 'length' | null) ?? null;
      const message = choice.message;

      // Extract text content (may be null when tool_calls are present)
      const content = message?.content ?? null;

      // Extract tool_calls if present
      const toolCalls: ToolCall[] = message?.tool_calls ?? [];

      return { content, toolCalls, finishReason };
    } catch (err) {
      // Re-throw structured errors as-is
      if (
        err instanceof LlmAuthError ||
        err instanceof LlmRateLimitError ||
        err instanceof LlmServerError ||
        err instanceof LlmTimeoutError ||
        err instanceof LlmParseError
      ) {
        throw err;
      }

      // Handle AbortError (from AbortSignal)
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new LlmTimeoutError('LLM request aborted due to timeout');
      }

      // Handle TypeError (network failures, DNS, etc.)
      if (err instanceof TypeError) {
        throw new LlmServerError(
          `Network error calling LLM: ${err.message}`,
        );
      }

      // Unknown error → server error
      throw new LlmServerError(
        `Unexpected error calling LLM: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Handle non-2xx HTTP responses by mapping to structured errors.
   */
  private async handleHttpError(response: Response): Promise<never> {
    const status = response.status;
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // best effort
    }

    const detail = bodyText.length > 0 ? `: ${bodyText.slice(0, 500)}` : '';

    if (status === 401 || status === 403) {
      throw new LlmAuthError(`LLM authentication failed (HTTP ${status})${detail}`, status);
    }

    if (status === 429) {
      throw new LlmRateLimitError(`LLM rate limit exceeded (HTTP 429)${detail}`, status);
    }

    if (status >= 500) {
      throw new LlmServerError(`LLM server error (HTTP ${status})${detail}`, status);
    }

    // Other 4xx
    throw new LlmServerError(`LLM request failed (HTTP ${status})${detail}`, status);
  }

  /**
   * Read an SSE/NDJSON stream and concatenate delta content fragments.
   *
   * Stream format (OpenAI):
   *   data: {"id":"...","choices":[{"delta":{"content":"hello"}}]}
   *   data: {"id":"...","choices":[{"delta":{"content":" world"}}]}
   *   data: [DONE]
   *
   * Also handles tool_calls deltas:
   *   data: {"id":"...","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}
   *   data: {"id":"...","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"loc"}}]}}]}
   */
  private async readStream(body: ReadableStream<Uint8Array>): Promise<LlmCompleteResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const contentChunks: string[] = [];
    let buffer = '';
    let finishReason: 'stop' | 'tool_calls' | 'length' | null = null;

    // Accumulate tool_calls by index
    const toolCallAccumulators: Map<number, {
      id?: string;
      type?: string;
      name?: string;
      arguments: string;
    }> = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        // The last element may be incomplete — keep it in buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // SSE lines start with "data: "
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6).trim();

          // Stream done signal
          if (data === '[DONE]') {
            return this.buildStreamResult(contentChunks, toolCallAccumulators, finishReason);
          }

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string | null;
              }>;
            };

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length';
            }

            const delta = choice.delta;
            if (!delta) continue;

            // Accumulate text content
            if (delta.content) {
              contentChunks.push(delta.content);
            }

            // Accumulate tool_calls deltas
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index;
                let acc = toolCallAccumulators.get(index);
                if (!acc) {
                  acc = { arguments: '' };
                  toolCallAccumulators.set(index, acc);
                }
                if (tc.id) acc.id = tc.id;
                if (tc.type) acc.type = tc.type;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.arguments += tc.function.arguments;
              }
            }
          } catch {
            // Skip unparseable lines — could be comments or keepalives
          }
        }
      }

      // Flush any remaining buffer at end of stream
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6).trim();
          if (data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{
                  delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
                  finish_reason?: string | null;
                }>;
              };
              const choice = parsed.choices?.[0];
              if (choice?.delta?.content) contentChunks.push(choice.delta.content);
              if (choice?.finish_reason) finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length';
            } catch {
              // skip
            }
          }
        }
      }

      return this.buildStreamResult(contentChunks, toolCallAccumulators, finishReason);
    } catch (err) {
      if (err instanceof LlmTimeoutError || err instanceof LlmServerError) {
        throw err;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new LlmTimeoutError('Streaming LLM request aborted due to timeout');
      }
      throw new LlmServerError(
        `Error reading LLM stream: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build a final LlmCompleteResult from accumulated stream data.
   */
  private buildStreamResult(
    contentChunks: string[],
    toolCallAccumulators: Map<number, { id?: string; type?: string; name?: string; arguments: string }>,
    finishReason: 'stop' | 'tool_calls' | 'length' | null,
  ): LlmCompleteResult {
    const content = contentChunks.length > 0 ? contentChunks.join('') : null;

    // Build tool_calls from accumulators
    const toolCalls: ToolCall[] = [];
    const sortedIndices = [...toolCallAccumulators.keys()].sort((a, b) => a - b);
    for (const index of sortedIndices) {
      const acc = toolCallAccumulators.get(index)!;
      toolCalls.push({
        id: acc.id ?? `call_${index}`,
        type: (acc.type as 'function') ?? 'function',
        function: {
          name: acc.name ?? '',
          arguments: acc.arguments,
        },
      });
    }

    return { content, toolCalls, finishReason };
  }
}

// ── Convenience Factory ───────────────────────────────────────

/**
 * Create an LlmClient instance.
 *
 * @param baseUrl The base URL of the OpenAI-compatible API (e.g. "https://api.openai.com").
 * @param apiKey  Optional API key for Bearer token authentication.
 */
export function createLlmClient(baseUrl: string, apiKey?: string): LlmClient {
  return new LlmClient(baseUrl, apiKey);
}
