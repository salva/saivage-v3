import type { Candidate } from '../contracts/provider-candidate.js';
import { ProviderTurnFailure, type LlmCompleteOptions, type LlmCompleteResult, type ProviderTurnCompletion, type ResponsesReplayProjection, type ToolDefinition } from './llm-contracts.js';
import { LlmRequestError } from './llm-errors.js';
import { classifierFor, classifyTransportFailure, defaultHttpClassifier } from './llm-failure-classifiers.js';
import { beginRecordedExchange, recordResponseError, teeStreamForRecorder } from './llm-recording.js';
import { serializeToolsForResponses, type WireToolDefinitionResponses } from './tool-definition-serializer.js';
import { responsesInputFromReplay } from './llm-openai-responses-mapper.js';
import { parseOpenAIResponsesJson, readOpenAIResponsesStream } from './llm-openai-responses-parser.js';
import type { EffectiveProviderCapabilities } from './provider-capabilities.js';

interface ResponsesToolChoiceNamed { type: 'function'; name: string }

interface OpenAIResponsesRequest {
  model: string;
  instructions: string;
  input: Record<string, unknown>[];
  store: false;
  include: ['reasoning.encrypted_content'];
  stream: boolean;
  max_output_tokens: number;
  tools?: readonly WireToolDefinitionResponses[];
  tool_choice?: 'auto' | ResponsesToolChoiceNamed;
  parallel_tool_calls?: false;
  reasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' };
}

export interface OpenAIResponsesGatewayConfig {
  baseUrl: string;
  apiKey?: string;
  capabilities: EffectiveProviderCapabilities;
}

export class OpenAIResponsesGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly capabilities: EffectiveProviderCapabilities;

  constructor(config: OpenAIResponsesGatewayConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.capabilities = config.capabilities;
  }

  async complete(candidate: Candidate, systemPrompt: string, replay: ResponsesReplayProjection, _sessionId: string, opts: LlmCompleteOptions): Promise<ProviderTurnCompletion> {
    if (!this.apiKey) throw new LlmRequestError({ kind: 'auth_permanent', provider: candidate.provider, status: 401, message: 'OpenAI Responses provider requires an API key' });
    const requestBody = buildOpenAIResponsesRequest(candidate, systemPrompt, replay, opts, this.capabilities);
    const endpoint = this.responsesUrl();
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Connection: 'close', Authorization: `Bearer ${this.apiKey}` };
    if (requestBody.stream) headers.Accept = 'text/event-stream';
    const handle = await beginRecordedExchange(opts.recorder, {
      transport: 'openai-responses',
      contract_id: opts.contract_id,
      contractName: opts.contractName,
      candidate,
      endpoint,
      requestParams: requestParamsFromBody(opts, requestBody),
      terminalToolOffered: opts.terminalToolOffered,
      sourceInputId: opts.inputId,
    });
    let recordedErr = false;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody), signal: opts.signal }).catch((err: unknown) => {
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
        const failure = classifierFor(candidate.provider).classifyHttp(response, bodyText, ctx) ?? defaultHttpClassifier(response, bodyText, ctx);
        if (handle && !recordedErr) {
          recordedErr = true;
          await handle.recordError({ errorName: 'LlmRequestError', message: failure.message, status: response.status });
        }
        throw providerFailure(new LlmRequestError(failure), opts.recorder);
      }
      if (requestBody.stream) {
        if (!response.body) throw new LlmRequestError({ kind: 'server_transient', provider: candidate.provider, status: response.status, message: 'OpenAI Responses streaming response has no body' });
        const parsed = handle ? await readOpenAIResponsesStream(teeStreamForRecorder(response.body).stream, { provider: candidate.provider, model: candidate.model, sourceInputId: opts.inputId }) : await readOpenAIResponsesStream(response.body, { provider: candidate.provider, model: candidate.model, sourceInputId: opts.inputId });
        if (handle) await handle.recordResponse({ status: response.status, token_usage: parsed.result.usage, finish_reason: parsed.responseStatus }, firedTerminalFromResult(parsed.result, opts));
        return { result: parsed.result, provider_exchanges: opts.recorder?.settledAttempts() ?? [], provider_private_context: parsed.privateContext };
      }
      const rawText = await response.text();
      const parsed = parseOpenAIResponsesJson(rawText, { provider: candidate.provider, model: candidate.model, sourceInputId: opts.inputId });
      if (handle) await handle.recordResponse({ status: response.status, token_usage: parsed.result.usage, finish_reason: parsed.responseStatus }, firedTerminalFromResult(parsed.result, opts));
      return { result: parsed.result, provider_exchanges: opts.recorder?.settledAttempts() ?? [], provider_private_context: parsed.privateContext };
    } catch (err) {
      if (handle && !recordedErr) await recordResponseError(handle, err);
      if (err instanceof ProviderTurnFailure) throw err;
      if (err instanceof LlmRequestError) throw providerFailure(err, opts.recorder);
      const failure = classifyTransportFailure(err, { provider: candidate.provider, model: candidate.model });
      throw providerFailure(new LlmRequestError(failure), opts.recorder);
    }
  }

  private responsesUrl(): string {
    if (/\/v1$/.test(this.baseUrl)) return `${this.baseUrl}/responses`;
    return `${this.baseUrl}/v1/responses`;
  }
}

export function buildOpenAIResponsesRequest(candidate: Candidate, systemPrompt: string, replay: ResponsesReplayProjection, opts: LlmCompleteOptions, capabilities?: Pick<EffectiveProviderCapabilities, 'responsesReasoning'>): OpenAIResponsesRequest {
  const tools: ToolDefinition[] = opts.phase === 'terminal' ? [opts.terminalToolDefinition] : opts.tools;
  const toolChoice: 'auto' | ResponsesToolChoiceNamed = opts.phase === 'terminal' ? { type: 'function', name: opts.terminalToolName } : opts.tool_choice.kind === 'required_named' ? { type: 'function', name: opts.tool_choice.toolName } : 'auto';
  const body: OpenAIResponsesRequest = {
    model: candidate.model,
    instructions: systemPrompt,
    input: responsesInputFromReplay(replay),
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: opts.max_tokens ?? 4096,
    stream: opts.stream === true,
  };
  if (tools.length > 0) {
    body.tools = serializeToolsForResponses(tools);
    body.tool_choice = toolChoice;
    body.parallel_tool_calls = false;
  }
  if (capabilities?.responsesReasoning) body.reasoning = capabilities.responsesReasoning;
  return body;
}

function requestParamsFromBody(opts: LlmCompleteOptions, body: OpenAIResponsesRequest): Record<string, unknown> {
  return { phase: opts.phase, stream: body.stream, offered_tools_count: body.tools?.length ?? 0, max_output_tokens: body.max_output_tokens, include: body.include, store: body.store, reasoning_keys: body.reasoning ? Object.keys(body.reasoning).sort() : [] };
}

function firedTerminalFromResult(result: LlmCompleteResult, opts: LlmCompleteOptions): string | null {
  if (result.kind !== 'tool_calls') return null;
  const offered = new Set(opts.terminalToolOffered);
  for (const call of result.tool_calls) if (offered.has(call.function.name)) return call.function.name;
  return null;
}

function providerFailure(error: unknown, recorder: LlmCompleteOptions['recorder']): ProviderTurnFailure {
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: recorder?.settledAttempts() ?? [], originalFailure: error });
}
