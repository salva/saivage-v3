/**
 * LLM Client — Makes OpenAI-compatible chat completions HTTP requests.
 *
 * Supports non-streaming and streaming (SSE/NDJSON) modes with structured
 * error types for auth, rate-limit, server, timeout, and parse failures.
 *
 * Also supports tool/function calling via the OpenAI `tools` parameter.
 */

import type { Candidate, ProviderRegistry } from './provider.js';
import {
  capabilityRequestForLlmOptions,
  supportsCapabilityRequest,
} from './provider-capabilities.js';
import { redactProviderLikeText } from '../utils/secret-redaction.js';
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

interface CodexInputText {
  type: 'input_text';
  text: string;
}

type CodexMessage =
  | { role: 'user'; content: CodexInputText[] }
  | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { role: 'system' | 'developer'; content: string }
  | Record<string, unknown>;

interface CodexTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const OPENAI_CODEX_JWT_CLAIM = 'https://api.openai.com/auth';

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
  private readonly registry: ProviderRegistry | undefined;

  constructor(baseUrl: string, apiKey?: string, registry?: ProviderRegistry) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.registry = registry;
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
    this.assertCandidateCapabilities(candidate, opts);

    if (candidate.provider === 'openai-codex') {
      return this.completeOpenAICodex(candidate, systemPrompt, messages, opts);
    }

    const temperature = opts?.temperature ?? 0.7;
    const maxTokens = opts?.max_tokens ?? 4096;
    const stream = opts?.stream ?? false;
    const signal = opts?.signal;
    const tools = opts?.tools;
    const toolChoice = opts?.tool_choice;

    // Build the message array: system prompt first, then conversation
    const apiMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => {
        if (m.role === 'assistant' && m.kind === 'tool_call') {
          return {
            role: 'assistant' as const,
            content: '',
            tool_calls: this.parsePersistedToolCalls(m.content),
          };
        }
        if (m.role === 'tool') {
          return {
            role: 'tool' as const,
            content: m.content,
            tool_call_id: m.tool_call_id ?? m.id,
          };
        }
        return {
          role: toChatRole(m.role),
          content: m.content,
        };
      }),
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

    const url = this.chatCompletionsUrl();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...this.providerHeaders(),
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

  private chatCompletionsUrl(): string {
    if (this.baseUrl.includes('githubcopilot.com')) {
      return `${this.baseUrl}/chat/completions`;
    }
    if (/\/v1$/.test(this.baseUrl)) {
      return `${this.baseUrl}/chat/completions`;
    }
    return `${this.baseUrl}/v1/chat/completions`;
  }

  private async completeOpenAICodex(
    candidate: Candidate,
    systemPrompt: string,
    messages: AgentMessage[],
    opts?: LlmCompleteOptions,
  ): Promise<LlmCompleteResult> {
    if (!this.apiKey) {
      throw new LlmAuthError('OpenAI Codex provider not configured', 401);
    }

    const input = this.codexMessages(messages);
    if (input.length === 0) {
      input.push({
        role: 'user',
        content: [{ type: 'input_text', text: 'Proceed with the task described in the instructions.' }],
      });
    }

    const body: Record<string, unknown> = {
      model: candidate.model,
      store: false,
      stream: true,
      instructions: systemPrompt,
      input,
    };
    if (opts?.max_tokens !== undefined) {
      body.max_output_tokens = opts.max_tokens;
    }
    if (opts?.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((tool) => this.codexTool(tool));
      body.tool_choice = opts.tool_choice ?? 'auto';
      body.parallel_tool_calls = true;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Connection: 'close',
      Authorization: `Bearer ${this.apiKey}`,
      'chatgpt-account-id': this.openAICodexAccountId(this.apiKey),
      originator: 'saivage',
      'OpenAI-Beta': 'responses=experimental',
    };

    try {
      let response = await fetch(this.openAICodexResponsesUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
      });

      if (!response.ok) {
        if (await this.isUnsupportedCodexMaxOutputTokensQuirk(response)) {
          const retryBody = { ...body };
          delete retryBody.max_output_tokens;
          response = await fetch(this.openAICodexResponsesUrl(), {
            method: 'POST',
            headers,
            body: JSON.stringify(retryBody),
            signal: opts?.signal,
          });
        }
        if (!response.ok) {
          await this.handleHttpError(response);
        }
      }
      if (!response.body) {
        throw new LlmServerError('OpenAI Codex streaming response has no body', response.status);
      }

      return await this.readOpenAICodexStream(response.body);
    } catch (err) {
      if (
        err instanceof LlmAuthError ||
        err instanceof LlmRateLimitError ||
        err instanceof LlmServerError ||
        err instanceof LlmTimeoutError ||
        err instanceof LlmParseError
      ) {
        throw err;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new LlmTimeoutError('OpenAI Codex request aborted due to timeout');
      }
      if (err instanceof TypeError) {
        throw new LlmServerError(`Network error calling OpenAI Codex: ${err.message}`);
      }
      throw new LlmServerError(
        `Unexpected error calling OpenAI Codex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }


  private async isUnsupportedCodexMaxOutputTokensQuirk(response: Response): Promise<boolean> {
    if (response.status !== 400) return false;

    let bodyText = '';
    try {
      bodyText = await response.clone().text();
    } catch {
      return false;
    }

    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (!parsed || typeof parsed !== 'object') return false;
      const detail = (parsed as Record<string, unknown>)['detail'];
      return detail === 'Unsupported parameter: max_output_tokens';
    } catch {
      return false;
    }
  }

  private openAICodexResponsesUrl(): string {
    const normalized = this.baseUrl.replace(/\/+$/, '');
    if (normalized.endsWith('/codex/responses')) return normalized;
    if (normalized.endsWith('/codex')) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
  }

  private openAICodexAccountId(token: string): string {
    try {
      const [, payload] = token.split('.');
      if (!payload) throw new Error('missing JWT payload');
      const decoded = Buffer.from(payload, 'base64url').toString('utf8');
      const claims = JSON.parse(decoded) as Record<string, unknown>;
      const authClaims = claims[OPENAI_CODEX_JWT_CLAIM] as Record<string, unknown> | undefined;
      const accountId = authClaims?.['chatgpt_account_id'];
      if (typeof accountId !== 'string' || accountId.length === 0) {
        throw new Error('missing chatgpt_account_id claim');
      }
      return accountId;
    } catch (err) {
      throw new LlmAuthError(
        `Failed to extract OpenAI Codex account id: ${err instanceof Error ? err.message : String(err)}`,
        401,
      );
    }
  }

  private codexMessages(messages: AgentMessage[]): CodexMessage[] {
    // The OpenAI Responses API requires every `function_call` item to be
    // followed by a matching `function_call_output`. If the persisted
    // history contains an orphan tool_call (e.g. because a prior planner
    // turn was rejected as malformed before the tool ran, or because
    // activate_card deliberately deferred its output while child work runs),
    // we must drop both the orphan call and any stray outputs whose call_id
    // has no preceding call. Pre-compute the set of call_ids that have both a
    // call and an output, then only emit those.
    const callIdsWithOutput = new Set<string>();
    const callIdsSeen = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant' && message.kind === 'tool_call') {
        for (const toolCall of this.parsePersistedToolCalls(message.content)) {
          if (toolCall.id) callIdsSeen.add(toolCall.id);
        }
      } else if (message.role === 'tool') {
        const toolMessage = message as AgentMessage & { tool_call_id?: string };
        const id = toolMessage.tool_call_id ?? message.id;
        if (id && callIdsSeen.has(id)) callIdsWithOutput.add(id);
      }
    }

    const result: CodexMessage[] = [];
    for (const message of messages) {
      if (message.role === 'user') {
        result.push({
          role: 'user',
          content: [{ type: 'input_text', text: message.content }],
        });
      } else if (message.role === 'assistant' && message.kind === 'tool_call') {
        for (const toolCall of this.parsePersistedToolCalls(message.content)) {
          if (!toolCall.id || !callIdsWithOutput.has(toolCall.id)) continue;
          result.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          });
        }
      } else if (message.role === 'assistant') {
        result.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }],
        });
      } else if (message.role === 'tool') {
        const toolMessage = message as AgentMessage & { tool_call_id?: string };
        const callId = toolMessage.tool_call_id ?? message.id;
        if (!callId || !callIdsWithOutput.has(callId)) continue;
        result.push({
          type: 'function_call_output',
          call_id: callId,
          output: message.content,
        });
      }
    }

    return result;
  }

  private parsePersistedToolCalls(content: string): ToolCall[] {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { toolCalls?: unknown }).toolCalls)) {
        return (parsed as { toolCalls: ToolCall[] }).toolCalls;
      }
    } catch {
      // Fall through to empty list.
    }
    return [];
  }

  private codexTool(tool: ToolDefinition): CodexTool {
    return {
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    };
  }

  private async readOpenAICodexStream(body: ReadableStream<Uint8Array>): Promise<LlmCompleteResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason: LlmCompleteResult['finishReason'] = 'stop';
    const pendingToolCalls = new Map<string, { id: string; name: string; args: string }>();
    const finalizedToolCalls = new Set<string>();
    const toolCalls: ToolCall[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.handleOpenAICodexSseChunk(chunk, pendingToolCalls, finalizedToolCalls, toolCalls, (delta) => {
            if (content.length > 0 && delta.startsWith(content)) {
              content = delta;
            } else if (!content.endsWith(delta)) {
              content += delta;
            }
          }, (reason) => {
            finishReason = reason;
          });
          boundary = buffer.indexOf('\n\n');
        }
      }

      if (toolCalls.length > 0) finishReason = 'tool_calls';
      return { content: content || null, toolCalls, finishReason };
    } catch (err) {
      if (err instanceof LlmServerError || err instanceof LlmParseError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new LlmTimeoutError('OpenAI Codex streaming request aborted due to timeout');
      }
      throw new LlmServerError(
        `Error reading OpenAI Codex stream: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      reader.releaseLock();
    }
  }

  private handleOpenAICodexSseChunk(
    chunk: string,
    pendingToolCalls: Map<string, { id: string; name: string; args: string }>,
    finalizedToolCalls: Set<string>,
    toolCalls: ToolCall[],
    appendContent: (delta: string) => void,
    setFinishReason: (reason: LlmCompleteResult['finishReason']) => void,
  ): void {
    const dataLines = chunk
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    for (const data of dataLines) {
      if (!data || data === '[DONE]') continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = event['type'];
      if (type === 'response.output_text.delta') {
        appendContent(String(event['delta'] ?? ''));
      } else if (type === 'response.output_item.added') {
        const item = event['item'] as Record<string, unknown> | undefined;
        if (item?.['type'] === 'function_call') {
          const callId = String(item['call_id'] ?? item['id'] ?? `call_${pendingToolCalls.size}`);
          const itemId = typeof item['id'] === 'string' ? item['id'] : undefined;
          const pending = {
            id: callId,
            name: String(item['name'] ?? ''),
            args: String(item['arguments'] ?? ''),
          };
          pendingToolCalls.set(callId, pending);
          if (itemId && itemId !== callId) pendingToolCalls.set(itemId, pending);
        }
      } else if (type === 'response.output_item.done') {
        const item = event['item'] as Record<string, unknown> | undefined;
        if (item?.['type'] === 'function_call') {
          const callId = String(item['call_id'] ?? item['id'] ?? `call_${toolCalls.length}`);
          const itemId = typeof item['id'] === 'string' ? item['id'] : undefined;
          const pending = pendingToolCalls.get(callId) ?? (itemId ? pendingToolCalls.get(itemId) : undefined);
          this.finalizeCodexToolCall(
            toolCalls,
            finalizedToolCalls,
            callId,
            String(item['name'] ?? pending?.name ?? ''),
            String(item['arguments'] ?? pending?.args ?? '{}'),
          );
          pendingToolCalls.delete(callId);
          if (itemId) pendingToolCalls.delete(itemId);
        } else if (item?.['type'] === 'message') {
          this.appendCodexMessageContent(item, appendContent);
        }
      } else if (type === 'response.content_part.done') {
        const part = event['part'] as Record<string, unknown> | undefined;
        if (part?.['type'] === 'output_text' && typeof part['text'] === 'string') {
          appendContent(part['text']);
        }
      } else if (type === 'response.output_text.done') {
        if (typeof event['text'] === 'string') appendContent(event['text']);
      } else if (type === 'response.function_call_arguments.delta') {
        const id = String(event['call_id'] ?? event['item_id'] ?? '');
        const pending = pendingToolCalls.get(id);
        if (pending) pending.args += String(event['delta'] ?? '');
      } else if (type === 'response.function_call_arguments.done') {
        const id = String(event['call_id'] ?? event['item_id'] ?? '');
        const pending = pendingToolCalls.get(id);
        const callId = String(event['call_id'] ?? pending?.id ?? id);
        if (pending || typeof event['arguments'] === 'string') {
          this.finalizeCodexToolCall(
            toolCalls,
            finalizedToolCalls,
            callId,
            String((event['name'] as string | undefined) ?? pending?.name ?? ''),
            String((event['arguments'] as string | undefined) ?? pending?.args ?? '{}'),
          );
          pendingToolCalls.delete(id);
          if (pending?.id) pendingToolCalls.delete(pending.id);
        }
      } else if (type === 'response.completed' || type === 'response.done') {
        const response = event['response'] as Record<string, unknown> | undefined;
        if (response?.['status'] === 'incomplete') setFinishReason('length');
      } else if (type === 'response.failed') {
        const response = event['response'] as Record<string, unknown> | undefined;
        const error = response?.['error'] as Record<string, unknown> | undefined;
        throw new LlmServerError(
          `OpenAI Codex response failed: ${this.redactProviderErrorText(String(error?.['message'] ?? 'unknown error'))}`,
        );
      } else if (type === 'error') {
        throw new LlmServerError(
          `OpenAI Codex stream error: ${this.redactProviderErrorText(String(event['message'] ?? JSON.stringify(event)))}`,
        );
      }
    }
  }

  private finalizeCodexToolCall(
    toolCalls: ToolCall[],
    finalizedToolCalls: Set<string>,
    id: string,
    name: string,
    args: string,
  ): void {
    if (finalizedToolCalls.has(id)) return;
    finalizedToolCalls.add(id);
    toolCalls.push({
      id,
      type: 'function',
      function: {
        name,
        arguments: args || '{}',
      },
    });
  }

  private appendCodexMessageContent(
    item: Record<string, unknown>,
    appendContent: (delta: string) => void,
  ): void {
    const content = item['content'];
    if (!Array.isArray(content)) return;

    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const typedPart = part as Record<string, unknown>;
      if (typedPart['type'] === 'output_text' && typeof typedPart['text'] === 'string') {
        appendContent(typedPart['text']);
      }
    }
  }

  private providerHeaders(): Record<string, string> {
    if (!this.baseUrl.includes('githubcopilot.com')) {
      return {};
    }
    return {
      'User-Agent': 'GitHubCopilotChat/0.35.0',
      'Editor-Version': 'vscode/1.107.0',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0',
      'Copilot-Integration-Id': 'vscode-chat',
    };
  }


  private redactProviderErrorText(text: string): string {
    return redactProviderLikeText(text);
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

    const detail = bodyText.length > 0 ? `: ${this.redactProviderErrorText(bodyText.slice(0, 500))}` : '';

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

  private assertCandidateCapabilities(candidate: Candidate, opts?: LlmCompleteOptions): void {
    if (!this.registry) return;
    const request = capabilityRequestForLlmOptions({
      tools: opts?.tools,
      tool_choice: opts?.tool_choice,
      stream: opts?.stream,
      responseShape: candidate.provider === 'openai-codex' ? 'codex-backend' : 'openai-chat-choice',
    });
    const capabilities = this.registry.getEffectiveCapabilities(candidate);
    const match = supportsCapabilityRequest(capabilities, request);
    if (!match.supported) {
      throw new LlmServerError(
        `Candidate ${candidate.provider}/${candidate.account ?? '_'}/${candidate.model} does not support requested LLM capabilities: ${match.reasons.join(', ')}`,
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
