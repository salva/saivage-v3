import type { AgentMessage } from '../schemas/index.js';
import type { Candidate } from './provider.js';
import type { LlmCompleteOptions, LlmCompleteResult, ToolCall, ToolDefinition, LlmUsage } from './llm-contracts.js';
import { parseToolCallMessage } from './persisted-tool-call.js';
import { LlmRequestError } from './llm-errors.js';
import { classifierFor, classifyTransportFailure, defaultHttpClassifier } from './llm-failure-classifiers.js';
import { beginRecordedExchange, recordResponseError, teeStreamForRecorder, deriveTerminalToolFromOptions } from './llm-recording.js';
import { readOpenAIChatStream } from './llm-stream-parser.js';
import { serializeToolsForChat, type WireToolDefinitionChat } from './tool-definition-serializer.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatToolChoice {
  type: 'function';
  function: { name: string };
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  stream: boolean;
  tools?: readonly WireToolDefinitionChat[];
  tool_choice?: 'auto' | ChatToolChoice;
  parallel_tool_calls?: false;
}

interface ChatCompletionResponse {
  choices: Array<{
    message?: { content: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: LlmUsage;
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
    opts: LlmCompleteOptions,
  ): Promise<LlmCompleteResult> {
    const requestBody = buildOpenAIChatRequest(candidate, systemPrompt, messages, opts);
    const url = this.chatCompletionsUrl();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...this.providerHeaders(),
    };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const handle = await beginRecordedExchange(opts.recorder, {
      transport: 'generic',
      contract_id: opts.contract_id,
      candidate,
      endpoint: url,
      headers,
      body: requestBody,
      terminalTool: deriveTerminalToolFromOptions(opts),
    });
    let recordedErr = false;
    let rawText: string | undefined;

    try {
      let response: Response;
      try {
        response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody), signal: opts.signal });
      } catch (err) {
        if (handle) {
          recordedErr = true;
          const e = err as Error;
          await handle.recordError({ errorName: e.name, message: e.message, bodyRaw: null });
        }
        throw err;
      }

      if (!response.ok) {
        const ctx = { provider: candidate.provider, model: candidate.model };
        const bodyText = await response.clone().text().catch(() => '');
        const failure = classifierFor(candidate.provider).classifyHttp(response, bodyText, ctx)
          ?? defaultHttpClassifier(response, bodyText, ctx);
        if (handle) {
          recordedErr = true;
          await handle.recordError({ errorName: 'LlmRequestError', message: failure.message, status: response.status, bodyRaw: bodyText });
        }
        throw new LlmRequestError(failure);
      }

      if (requestBody.stream) {
        if (!response.body) throw new LlmRequestError({ kind: 'server_transient', provider: candidate.provider, status: response.status, message: 'Streaming response has no body' });
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
        throw new LlmRequestError({ kind: 'parse_error', provider: candidate.provider, message: `Failed to parse chat completions response: ${err instanceof Error ? err.message : String(err)}`, bodyPreview: rawText.slice(0, 500) });
      }
      if (!parsed.choices || parsed.choices.length === 0) {
        throw new LlmRequestError({ kind: 'parse_error', provider: candidate.provider, message: 'Chat completions response contains no choices', bodyPreview: rawText.slice(0, 500) });
      }
      const choice = parsed.choices[0];
      const toolCalls = choice.message?.tool_calls ?? [];
      const result: LlmCompleteResult = toolCalls.length > 0
        ? { kind: 'tool_calls', tool_calls: toolCalls, usage: parsed.usage }
        : { kind: 'message', content: choice.message?.content ?? '', usage: parsed.usage };
      if (handle) await handle.recordResponse({ status: response.status, bodyRaw: rawText, bodyParsed: parsed });
      return result;
    } catch (err) {
      if (handle && !recordedErr) await recordResponseError(handle, err, rawText ?? null);
      if (err instanceof LlmRequestError) throw err;
      const failure = classifyTransportFailure(err, { provider: candidate.provider, model: candidate.model });
      throw new LlmRequestError(failure);
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
  opts: LlmCompleteOptions,
): ChatCompletionRequest {
  const apiMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m): ChatMessage => {
      if (m.role === 'assistant' && m.kind === 'tool_call') {
        const call = parseToolCallMessage(JSON.parse(m.content));
        return { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
      }
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id ?? m.id };
      }
      return { role: toChatRole(m.role), content: m.content };
    }),
  ];

  const sanitized = sanitizeToolCallSequences(apiMessages);

  const tools: ToolDefinition[] = opts.phase === 'terminal'
    ? [opts.terminalToolDefinition]
    : opts.tools;
  const toolChoice: 'auto' | ChatToolChoice = opts.phase === 'terminal'
    ? { type: 'function', function: { name: opts.terminalToolName } }
    : opts.tool_choice.kind === 'required_named'
      ? { type: 'function', function: { name: opts.tool_choice.toolName } }
      : 'auto';

  const body: ChatCompletionRequest = {
    model: candidate.model,
    messages: sanitized,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 4096,
    stream: opts.stream ?? false,
  };
  if (tools.length > 0) {
    body.tools = serializeToolsForChat(tools);
    body.tool_choice = toolChoice;
    body.parallel_tool_calls = false;
  }
  return body;
}

function sanitizeToolCallSequences(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const need = new Set(m.tool_calls.map((c) => c.id));
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool') {
        const tcid = msgs[j].tool_call_id;
        if (tcid) need.delete(tcid);
        j++;
      }
      if (need.size > 0) {
        if (m.content && m.content.length > 0) out.push({ role: 'assistant', content: m.content });
        continue;
      }
    }
    out.push(m);
  }
  return out;
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
