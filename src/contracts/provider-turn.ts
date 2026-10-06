import type { ProviderExchangeAttempt } from './provider-exchange.js';
import type { Candidate } from './provider-candidate.js';
import type { LlmUsage } from './llm-usage.js';

interface ToolFunctionDefinition {
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

export type LlmCompleteResult =
  | { kind: 'tool_calls'; tool_calls: ToolCall[]; usage?: LlmUsage }
  | { kind: 'message'; content: string; usage?: LlmUsage };

export interface OpenAIResponsesPrivateContext {
  kind: 'openai_responses';
  producer_account_id: string;
  source_input_id: string;
  provider: string;
  model: string;
  output: unknown[];
}

export type ProviderPrivateContext = OpenAIResponsesPrivateContext;

export interface ProviderTurnCompletion {
  result: LlmCompleteResult;
  provider_exchanges: ProviderExchangeAttempt[];
  provider_private_context?: ProviderPrivateContext;
}

export class ProviderTurnFailure extends Error {
  readonly failure_phase: 'pre_provider' | 'provider_attempt';
  readonly provider_exchanges: ProviderExchangeAttempt[];
  readonly originalFailure: unknown;
  readonly candidate: Candidate | null;

  constructor(args: {
    failure_phase: 'pre_provider' | 'provider_attempt';
    provider_exchanges: ProviderExchangeAttempt[];
    originalFailure: unknown;
    message?: string;
    candidate: Candidate | null;
  }) {
    super(
      args.message ??
        (args.originalFailure instanceof Error
          ? args.originalFailure.message
          : String(args.originalFailure)),
    );
    this.name = 'ProviderTurnFailure';
    this.failure_phase = args.failure_phase;
    this.provider_exchanges = args.provider_exchanges;
    this.originalFailure = args.originalFailure;
    this.candidate = args.candidate;
    this.cause = args.originalFailure;
  }
}
