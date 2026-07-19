import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import { builtInCapabilitiesForProvider, capabilityRequestForLlmOptions, supportsCapabilityRequest } from './provider-capabilities.js';
import { assertProviderConversationSourceRows, type LlmCompleteOptions, type ProviderConversationProjection, type ProviderTurnCompletion, type LlmInvocationClient } from './llm-contracts.js';
import { LlmRequestError } from './llm-errors.js';
import { OpenAIChatGateway } from './llm-openai-chat-gateway.js';
import { OpenAICodexGateway } from './llm-openai-codex-gateway.js';
import { OpenAIResponsesGateway } from './llm-openai-responses-gateway.js';

export interface LlmProviderGatewayConfig {
  baseUrl: string;
  apiKey?: string;
  openAICodexAccountId?: string;
  registry?: ProviderRegistry;
}

export class LlmProviderGateway implements LlmInvocationClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly openAICodexAccountId: string | undefined;
  private readonly registry: ProviderRegistry | undefined;

  constructor(config: LlmProviderGatewayConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.openAICodexAccountId = config.openAICodexAccountId;
    this.registry = config.registry;
  }

  async complete(
    candidate: Candidate,
    systemPrompt: string,
    providerConversation: ProviderConversationProjection,
    sessionId: string,
    opts: LlmCompleteOptions,
  ): Promise<ProviderTurnCompletion> {
    assertProviderConversationSourceRows(providerConversation);
    this.assertCandidateCapabilities(candidate, opts);
    const transport = this.registry?.getEffectiveCapabilities(candidate).transportProtocol ?? builtInCapabilitiesForProvider(candidate.provider).transportProtocol;
    if (transport === 'openai-responses') {
      if (!this.registry) throw new Error('openai-responses dispatch requires a provider registry.');
      return new OpenAIResponsesGateway({ baseUrl: this.baseUrl, apiKey: this.apiKey, capabilities: this.registry.getEffectiveCapabilities(candidate) }).complete(candidate, systemPrompt, providerConversation, sessionId, opts);
    }
    if (transport === 'openai-codex-backend') {
      if (!this.apiKey || !this.openAICodexAccountId) throw new Error('openai-codex dispatch requires resolved credential and account id.');
      return new OpenAICodexGateway({ baseUrl: this.baseUrl, apiKey: this.apiKey, openAICodexAccountId: this.openAICodexAccountId }).complete(candidate, systemPrompt, providerConversation, sessionId, opts);
    }
    return new OpenAIChatGateway({ baseUrl: this.baseUrl, apiKey: this.apiKey }).complete(candidate, systemPrompt, providerConversation, sessionId, opts);
  }

  private assertCandidateCapabilities(candidate: Candidate, opts: LlmCompleteOptions): void {
    if (!this.registry) return;
    const request = capabilityRequestForLlmOptions({
      tools: opts.tools,
      stream: opts.stream,
    });
    const capabilities = this.registry.getEffectiveCapabilities(candidate);
    const match = supportsCapabilityRequest(capabilities, request);
    if (!match.supported) {
      throw new LlmRequestError({
        kind: 'capability_mismatch',
        provider: candidate.provider,
        model: candidate.model,
        requested: match.reasons,
        supported: [],
        message: `Candidate ${JSON.stringify(candidate)} does not support requested LLM capabilities: ${match.reasons.join(', ')}`,
      });
    }
  }
}
