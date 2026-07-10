import type { AgentMessage } from '../schemas/index.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderExchangeAttempt } from '../contracts/provider-exchange.js';
import type { ProviderExchangeRecorder } from './provider-exchange-recorder.js';
import type { CapabilityRequest } from './provider-capabilities.js';

export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type TerminalChoice =
  | { kind: 'auto' }
  | { kind: 'required_named'; toolName: string };

export interface LlmModelParams {
  temperature?: number;
  max_tokens?: number;
}

interface LlmCompleteOptionsBase extends LlmModelParams {
  inputId: string;
  stream?: boolean;
  signal?: AbortSignal;
  recorder?: ProviderExchangeRecorder;
  capabilityRequest?: CapabilityRequest;
  contract_id: string;
  contractName: string;
  terminalToolOffered: readonly string[];
}

export interface LlmCompleteOptionsTools extends LlmCompleteOptionsBase {
  phase: 'tools';
  tools: ToolDefinition[];
  tool_choice: TerminalChoice;
}

export interface LlmCompleteOptionsTerminal extends LlmCompleteOptionsBase {
  phase: 'terminal';
  terminalToolName: string;
  terminalToolDefinition: ToolDefinition;
}

export type LlmCompleteOptions = LlmCompleteOptionsTools | LlmCompleteOptionsTerminal;

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export type LlmCompleteResult =
  | { kind: 'tool_calls'; tool_calls: ToolCall[]; usage?: LlmUsage }
  | { kind: 'message'; content: string; usage?: LlmUsage };

export interface OpenAIResponsesPrivateContext {
  kind: 'openai_responses';
  source_input_id: string;
  provider: string;
  model: string;
  output: unknown[];
}

export type ProviderPrivateContext = OpenAIResponsesPrivateContext;

export interface ResponsesReplayProjection {
  sessionId: string;
  messages: AgentMessage[];
}

export interface ProviderTurnCompletion {
  result: LlmCompleteResult;
  provider_exchanges: ProviderExchangeAttempt[];
  provider_private_context?: ProviderPrivateContext;
}

export class ProviderTurnFailure extends Error {
  readonly failure_phase: 'pre_provider' | 'provider_attempt';
  readonly provider_exchanges: ProviderExchangeAttempt[];
  readonly originalFailure: unknown;
  readonly failure?: unknown;

  constructor(args: { failure_phase: 'pre_provider' | 'provider_attempt'; provider_exchanges: ProviderExchangeAttempt[]; originalFailure: unknown; message?: string }) {
    super(args.message ?? (args.originalFailure instanceof Error ? args.originalFailure.message : String(args.originalFailure)));
    this.name = 'ProviderTurnFailure';
    this.failure_phase = args.failure_phase;
    this.provider_exchanges = args.provider_exchanges;
    this.originalFailure = args.originalFailure;
    if (typeof args.originalFailure === 'object' && args.originalFailure !== null && 'failure' in args.originalFailure) this.failure = (args.originalFailure as { failure: unknown }).failure;
    this.cause = args.originalFailure;
  }
}

export interface LlmInvocationClient {
  complete(
    candidate: Candidate,
    systemPrompt: string,
    genericContextMessages: AgentMessage[],
    activeConversationReplayOrSessionId: ResponsesReplayProjection | string,
    sessionIdOrOpts: string | LlmCompleteOptions,
    opts?: LlmCompleteOptions,
  ): Promise<ProviderTurnCompletion>;
}

export type LlmCallFn = (
  candidate: Candidate,
  systemPrompt: string,
  genericContextMessages: AgentMessage[],
  activeConversationReplayOrSessionId: ResponsesReplayProjection | string,
  sessionIdOrOpts: string | LlmCompleteOptions,
  opts?: LlmCompleteOptions,
) => Promise<ProviderTurnCompletion>;

export function parseCompleteInvocationArgs(
  messages: AgentMessage[],
  activeConversationReplayOrSessionId: ResponsesReplayProjection | string,
  sessionIdOrOpts: string | LlmCompleteOptions,
  opts?: LlmCompleteOptions,
): { genericContextMessages: AgentMessage[]; activeConversationReplay: ResponsesReplayProjection; sessionId: string; opts: LlmCompleteOptions } {
  if (typeof activeConversationReplayOrSessionId === 'string') {
    if (typeof sessionIdOrOpts === 'string' || opts !== undefined) throw new Error('Complete invocation has invalid generic-only argument shape.');
    return { genericContextMessages: messages, activeConversationReplay: { sessionId: activeConversationReplayOrSessionId, messages }, sessionId: activeConversationReplayOrSessionId, opts: sessionIdOrOpts };
  }
  if (typeof sessionIdOrOpts !== 'string' || !opts) throw new Error('Complete invocation requires sessionId and options.');
  return { genericContextMessages: messages, activeConversationReplay: activeConversationReplayOrSessionId, sessionId: sessionIdOrOpts, opts };
}
