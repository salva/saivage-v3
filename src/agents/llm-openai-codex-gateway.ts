import type { AgentMessage } from '../schemas/index.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import { ProviderTurnFailure, type LlmCompleteOptions, type LlmCompleteResult, type ProviderTurnCompletion, type ToolDefinition } from './llm-contracts.js';
import { parseToolCallMessageForModel } from '../contracts/persisted-tool-call.js';
import { sourceInputIdFromToolCallMessageId, sourceInputIdFromToolResultMessageId } from '../schemas/message-identity.js';
import { LlmRequestError } from './llm-errors.js';
import { classifierFor, classifyTransportFailure, defaultHttpClassifier } from './llm-failure-classifiers.js';
import { readOpenAICodexStream } from './llm-codex-parser.js';
import { beginRecordedExchange, recordResponseError, teeStreamForRecorder } from './llm-recording.js';
import { serializeToolsForCodex } from './tool-definition-serializer.js';

interface CodexInputText { type: 'input_text'; text: string; }
type CodexMessage =
  | { role: 'user'; content: CodexInputText[] }
  | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { role: 'system'; content: string }
  | Record<string, unknown>;

export interface OpenAICodexGatewayConfig {
  baseUrl: string;
  apiKey: string;
  openAICodexAccountId: string;
}

export class OpenAICodexGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly openAICodexAccountId: string;

  constructor(config: OpenAICodexGatewayConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.openAICodexAccountId = config.openAICodexAccountId;
  }

  async complete(
    candidate: Candidate,
    systemPrompt: string,
    messages: AgentMessage[],
    _sessionId: string,
    opts: LlmCompleteOptions,
  ): Promise<ProviderTurnCompletion> {
    const body = opts.builtCandidateRequest?.body ?? buildOpenAICodexRequest(candidate, systemPrompt, messages, opts);
    const serializedBody = opts.builtCandidateRequest?.serializedBody ?? JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Connection: 'close',
      Authorization: `Bearer ${this.apiKey}`,
      'chatgpt-account-id': this.openAICodexAccountId,
      originator: 'saivage',
      'OpenAI-Beta': 'responses=experimental',
    };
    const endpoint = this.openAICodexResponsesUrl();
    const handle = await beginRecordedExchange(opts.recorder, {
      transport: 'codex',
      contract_id: opts.contract_id,
      contractName: opts.contractName,
      candidate,
      endpoint,
      requestParams: { stream: true, phase: opts.phase, offered_tools_count: opts.phase === 'terminal' ? 1 : opts.tools.length },
      terminalToolOffered: opts.terminalToolOffered,
      sourceInputId: opts.inputId,
    });
    let recordedErr = false;
    let streamBuffer: string | undefined;

    try {
      const response = await fetch(endpoint, { method: 'POST', headers, body: serializedBody, signal: opts.signal }).catch((err: unknown) => {
        if (handle) {
          recordedErr = true;
          const e = err as Error;
          return handle.recordError({ errorName: e.name, message: e.message }).then(() => { throw err; });
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
          await handle.recordError({ errorName: 'LlmRequestError', message: failure.message, status: response.status });
        }
        throw providerFailure(new LlmRequestError(failure), opts.recorder);
      }
      if (!response.body) throw new LlmRequestError({ kind: 'server_transient', provider: candidate.provider, status: response.status, message: 'OpenAI Codex streaming response has no body' });

      if (handle) {
        const tee = teeStreamForRecorder(response.body);
        const result = await readOpenAICodexStream(tee.stream);
        streamBuffer = tee.getBuffer();
        await handle.recordResponse({ status: response.status, token_usage: result.usage }, firedTerminalFromCodexResult(result, opts));
        return { result, provider_exchanges: opts.recorder?.settledAttempts() ?? [] };
      }
      const result = await readOpenAICodexStream(response.body);
      return { result, provider_exchanges: opts.recorder?.settledAttempts() ?? [] };
    } catch (err) {
      if (handle && !recordedErr) await recordResponseError(handle, err);
      if (err instanceof ProviderTurnFailure) throw err;
      if (err instanceof LlmRequestError) throw providerFailure(err, opts.recorder);
      const failure = classifyTransportFailure(err, { provider: candidate.provider, model: candidate.model });
      throw providerFailure(new LlmRequestError(failure), opts.recorder);
    }
  }

  private openAICodexResponsesUrl(): string {
    if (this.baseUrl.endsWith('/codex/responses')) return this.baseUrl;
    if (this.baseUrl.endsWith('/codex')) return `${this.baseUrl}/responses`;
    return `${this.baseUrl}/codex/responses`;
  }
}

function providerFailure(error: unknown, recorder: LlmCompleteOptions['recorder']): ProviderTurnFailure {
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: recorder?.settledAttempts() ?? [], originalFailure: error });
}

export function buildOpenAICodexRequest(
  candidate: Candidate,
  systemPrompt: string,
  messages: AgentMessage[],
  opts: LlmCompleteOptions,
): Record<string, unknown> {
  const systemContext = messages.filter((message) => message.role === 'system').map((message) => message.content);
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
    instructions: [systemPrompt, ...systemContext].join('\n\n--- system context ---\n'),
    input,
    max_output_tokens: opts.max_tokens ?? 4096,
  };
  if (tools.length > 0) {
    body.tools = serializeToolsForCodex(tools);
    body.tool_choice = toolChoice;
    body.parallel_tool_calls = false;
  }
  return body;
}

function firedTerminalFromCodexResult(result: LlmCompleteResult, opts: LlmCompleteOptions): string | null {
  if (result.kind !== 'tool_calls') return null;
  const offered = new Set(opts.terminalToolOffered);
  for (const call of result.tool_calls) {
    if (offered.has(call.function.name)) return call.function.name;
  }
  return null;
}

export function codexMessages(messages: AgentMessage[]): CodexMessage[] {
  const callsWithOutput = new Set<string>();
  const callsSeen = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.kind === 'tool_call') {
      const call = parseToolCallMessageForModel(JSON.parse(message.content));
      callsSeen.add(`${sourceInputIdFromToolCallMessageId(message.id, call.id)}\u0000${call.id}`);
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error(`Codex tool settlement '${message.id}' is missing tool_call_id.`);
      const key = `${sourceInputIdFromToolResultMessageId(message.id, message.tool_call_id)}\u0000${message.tool_call_id}`;
      if (callsSeen.has(key)) callsWithOutput.add(key);
    }
  }

  const result: CodexMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      result.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
    } else if (message.role === 'assistant' && message.kind === 'tool_call') {
      const call = parseToolCallMessageForModel(JSON.parse(message.content));
      if (!callsWithOutput.has(`${sourceInputIdFromToolCallMessageId(message.id, call.id)}\u0000${call.id}`)) continue;
      result.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
    } else if (message.role === 'assistant') {
      result.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
    } else if (message.role === 'tool') {
      const callId = message.tool_call_id;
      if (!callId || !callsWithOutput.has(`${sourceInputIdFromToolResultMessageId(message.id, callId)}\u0000${callId}`)) continue;
      result.push({ type: 'function_call_output', call_id: callId, output: message.content });
    }
  }
  return result;
}
