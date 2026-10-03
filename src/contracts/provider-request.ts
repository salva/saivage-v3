import type { Candidate } from './provider-candidate.js';
import type { EffectiveProviderCapabilities } from './provider-capabilities.js';
import type { CapabilityRequest } from './provider-capabilities.js';
import type { ToolDefinition, LlmCompleteResult, ProviderPrivateContext } from './provider-turn.js';
import type { ProviderConversationProjection } from './provider-conversation.js';
import type { LlmRequestError } from './llm-failure.js';

interface BuiltCandidateRequest {
  body: Record<string, unknown>;
  serializedBody: string;
  estimatedWireInputTokens: number;
  requestHash: string;
}

export interface LlmModelParams {
  temperature: number;
  max_tokens: number;
}

export interface LlmCompleteOptions extends LlmModelParams {
  inputId: string;
  signal?: AbortSignal;
  capabilityRequest?: CapabilityRequest;
  contract_id: string;
  contractName: string;
  terminalToolOffered: readonly string[];
  tools: ToolDefinition[];
  tool_choice: 'auto';
}

export interface LlmTransportConfig {
  baseUrl: string;
  apiKey?: string;
  openAICodexAccountId?: string;
}

export type LlmCredentialRequirement = 'standard' | 'openai_responses_api_key';

interface LlmAdapterRequestInput {
  candidate: Candidate;
  systemPrompt: string;
  providerConversation: ProviderConversationProjection;
  options: LlmCompleteOptions;
  capabilities: EffectiveProviderCapabilities;
}

interface LlmAdapterWire {
  endpoint: string;
  headers: Record<string, string>;
  requestParams: Record<string, unknown>;
  transport: 'generic' | 'codex' | 'openai-responses';
}

interface LlmAdapterSuccess {
  result: LlmCompleteResult;
  privateContext?: ProviderPrivateContext;
  finishReason?: string | null;
}

export interface LlmResponseConsumption {
  signal: AbortSignal;
  onData(): void;
  readText(response: Response): Promise<string>;
}

export interface LlmProtocolAdapter {
  readonly credentialRequirement: LlmCredentialRequirement;
  buildRequestBody(input: LlmAdapterRequestInput): Record<string, unknown>;
  deriveWire(
    candidate: Candidate,
    transport: LlmTransportConfig,
    body: Record<string, unknown>,
    options: LlmCompleteOptions,
  ): LlmAdapterWire;
  classifyHttpFailure(
    candidate: Candidate,
    response: Response,
    bodyText: string,
    body: Record<string, unknown>,
    options: LlmCompleteOptions,
  ): LlmRequestError;
  parseSuccess(
    candidate: Candidate,
    response: Response,
    options: LlmCompleteOptions,
    consumption: LlmResponseConsumption,
  ): Promise<LlmAdapterSuccess>;
}

export interface CandidateRequestPlan {
  candidate: Candidate;
  capabilities: EffectiveProviderCapabilities;
  adapter: LlmProtocolAdapter;
  request: BuiltCandidateRequest;
}
