import type { Candidate } from '../contracts/provider-candidate.js';
import type { LlmTransportConfig } from './llm-transport.js';
import type { EffectiveProviderCapabilities, TransportProtocol } from './provider-capabilities.js';
import type {
  LlmCompleteOptions,
  LlmCompleteResult,
  ProviderConversationProjection,
  ProviderPrivateContext,
} from './llm-contracts.js';
import type { LlmRequestError } from './llm-errors.js';
import { openAIChatAdapter } from './llm-openai-chat-adapter.js';
import { openAIResponsesAdapter } from './llm-openai-responses-adapter.js';
import { openAICodexAdapter } from './llm-openai-codex-adapter.js';

export type LlmCredentialRequirement = 'standard' | 'openai_responses_api_key';

export interface LlmAdapterRequestInput {
  candidate: Candidate;
  systemPrompt: string;
  providerConversation: ProviderConversationProjection;
  options: LlmCompleteOptions;
  capabilities: EffectiveProviderCapabilities;
}

export interface LlmAdapterWire {
  endpoint: string;
  headers: Record<string, string>;
  requestParams: Record<string, unknown>;
  transport: 'generic' | 'codex' | 'openai-responses';
  streaming: boolean;
}

export interface LlmAdapterSuccess {
  result: LlmCompleteResult;
  privateContext?: ProviderPrivateContext;
  finishReason?: string | null;
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
  ): Promise<LlmAdapterSuccess>;
}

export function selectLlmProtocolAdapter(protocol: TransportProtocol): LlmProtocolAdapter {
  switch (protocol) {
    case 'openai-chat-completions':
      return openAIChatAdapter;
    case 'openai-responses':
      return openAIResponsesAdapter;
    case 'openai-codex-backend':
      return openAICodexAdapter;
    default: {
      const impossibleProtocol: never = protocol;
      throw new Error(`Unsupported LLM transport protocol '${String(impossibleProtocol)}'.`);
    }
  }
}
