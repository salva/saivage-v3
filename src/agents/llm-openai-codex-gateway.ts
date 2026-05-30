import { Buffer } from 'node:buffer';
import type { AgentMessage } from '../schemas/index.js';
import type { Candidate } from './provider.js';
import type { LlmCompleteOptions, LlmCompleteResult, ToolDefinition } from './llm-contracts.js';
import { parseToolCallMessage } from './persisted-tool-call.js';
import { LlmRequestError } from './llm-errors.js';
import { classifierFor, classifyTransportFailure, defaultHttpClassifier } from './llm-failure-classifiers.js';
import { readOpenAICodexStream } from './llm-codex-parser.js';
import { beginRecordedExchange, recordResponseError, teeStreamForRecorder, deriveTerminalToolFromOptions } from './llm-recording.js';

const OPENAI_CODEX_JWT_CLAIM = 'https://api.openai.com/auth';

interface CodexInputText { type: 'input_text'; text: string; }
type CodexMessage =
  | { role: 'user'; content: CodexInputText[] }
  | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { role: 'system' | 'developer'; content: string }
  | Record<string, unknown>;
interface CodexTool { type: 'function'; name: string; description: string; parameters: Record<string, unknown>; }

export interface OpenAICodexGatewayConfig {
  baseUrl: string;
  apiKey?: string;
}

export class OpenAICodexGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(config: OpenAICodexGatewayConfig) {
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
    if (!this.apiKey) throw new LlmRequestError({ kind: 'auth_permanent', provider: candidate.provider, status: 401, message: 'OpenAI Codex provider not configured' });

    const body = buildOpenAICodexRequest(candidate, systemPrompt, messages, opts);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Connection: 'close',
      Authorization: `Bearer ${this.apiKey}`,
      'chatgpt-account-id': openAICodexAccountId(this.apiKey),
      originator: 'saivage',
      'OpenAI-Beta': 'responses=experimental',
    };
    const endpoint = this.openAICodexResponsesUrl();
    const handle = await beginRecordedExchange(opts.recorder, {
      transport: 'codex',
      candidate,
      endpoint,
      headers,
      body,
      terminalTool: deriveTerminalToolFromOptions(opts),
    });
    let recordedErr = false;
    let streamBuffer: string | undefined;

    try {
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal }).catch((err: unknown) => {
        if (handle) {
          recordedErr = true;
          const e = err as Error;
          return handle.recordError({ errorName: e.name, message: e.message, bodyRaw: null }).then(() => { throw err; });
        }
        throw err;
      });

      if (!response.ok) {
        const ctx = { provider: candidate.provider, model: candidate.model };
        const bodyText = await response.clone().text().catch(() => '');
        const failure = classifierFor(candidate.provider).classifyHttp(response, bodyText, ctx)
          ?? defaultHttpClassifier(response, bodyText, ctx);
        if (handle && !recordedErr) {
          recordedErr = true;
          await handle.recordError({ errorName: 'LlmRequestError', message: failure.message, status: response.status, bodyRaw: bodyText });
        }
        throw new LlmRequestError(failure);
      }
      if (!response.body) throw new LlmRequestError({ kind: 'server_transient', provider: candidate.provider, status: response.status, message: 'OpenAI Codex streaming response has no body' });

      if (handle) {
        const tee = teeStreamForRecorder(response.body);
        const result = await readOpenAICodexStream(tee.stream);
        streamBuffer = tee.getBuffer();
        await handle.recordResponse({ status: response.status, bodyRaw: streamBuffer, bodyParsed: result });
        return result;
      }
      return await readOpenAICodexStream(response.body);
    } catch (err) {
      if (handle && !recordedErr) await recordResponseError(handle, err, streamBuffer ?? null);
      if (err instanceof LlmRequestError) throw err;
      const failure = classifyTransportFailure(err, { provider: candidate.provider, model: candidate.model });
      throw new LlmRequestError(failure);
    }
  }

  private openAICodexResponsesUrl(): string {
    if (this.baseUrl.endsWith('/codex/responses')) return this.baseUrl;
    if (this.baseUrl.endsWith('/codex')) return `${this.baseUrl}/responses`;
    return `${this.baseUrl}/codex/responses`;
  }
}

export function buildOpenAICodexRequest(
  candidate: Candidate,
  systemPrompt: string,
  messages: AgentMessage[],
  opts: LlmCompleteOptions,
): Record<string, unknown> {
  const input = codexMessages(messages);
  if (input.length === 0) {
    input.push({ role: 'user', content: [{ type: 'input_text', text: 'Proceed with the task described in the instructions.' }] });
  }
  const tools: ToolDefinition[] = opts.phase === 'terminal'
    ? [opts.terminalToolDefinition]
    : opts.tools;
  // Codex Responses API uses flat tool_choice: either 'auto' or a string tool name.
  const toolChoice: string = opts.phase === 'terminal'
    ? opts.terminalToolName
    : opts.tool_choice.kind === 'required_named'
      ? opts.tool_choice.toolName
      : 'auto';
  const body: Record<string, unknown> = {
    model: candidate.model,
    store: false,
    stream: true,
    instructions: systemPrompt,
    input,
    tools: tools.map(codexTool),
    tool_choice: toolChoice,
    parallel_tool_calls: false,
  };
  return body;
}

export function codexMessages(messages: AgentMessage[]): CodexMessage[] {
  const callIdsWithOutput = new Set<string>();
  const callIdsSeen = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.kind === 'tool_call') {
      const call = parseToolCallMessage(JSON.parse(message.content));
      callIdsSeen.add(call.id);
    } else if (message.role === 'tool') {
      const toolMessage = message as AgentMessage & { tool_call_id?: string };
      const id = toolMessage.tool_call_id ?? message.id;
      if (id && callIdsSeen.has(id)) callIdsWithOutput.add(id);
    }
  }

  const result: CodexMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
    } else if (message.role === 'assistant' && message.kind === 'tool_call') {
      const call = parseToolCallMessage(JSON.parse(message.content));
      if (!callIdsWithOutput.has(call.id)) continue;
      result.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
    } else if (message.role === 'assistant') {
      result.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
    } else if (message.role === 'tool') {
      const toolMessage = message as AgentMessage & { tool_call_id?: string };
      const callId = toolMessage.tool_call_id ?? message.id;
      if (!callId || !callIdsWithOutput.has(callId)) continue;
      result.push({ type: 'function_call_output', call_id: callId, output: message.content });
    }
  }
  return result;
}

export function openAICodexAccountId(token: string): string {
  try {
    const [, payload] = token.split('.');
    if (!payload) throw new Error('missing JWT payload');
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const claims = JSON.parse(decoded) as Record<string, unknown>;
    const authClaims = claims[OPENAI_CODEX_JWT_CLAIM] as Record<string, unknown> | undefined;
    const accountId = authClaims?.['chatgpt_account_id'];
    if (typeof accountId !== 'string' || accountId.length === 0) throw new Error('missing chatgpt_account_id claim');
    return accountId;
  } catch (err) {
    throw new LlmRequestError({ kind: 'auth_permanent', provider: 'openai-codex', status: 401, message: `Failed to extract OpenAI Codex account id: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function codexTool(tool: ToolDefinition): CodexTool {
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}
