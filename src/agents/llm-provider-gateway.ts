import type { AgentMessage } from '../schemas/index.js';
import { candidateKey, type Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import { capabilityRequestForLlmOptions, supportsCapabilityRequest } from './provider-capabilities.js';
import type { LlmCompleteOptions, ProviderTurnCompletion, LlmInvocationClient } from './llm-contracts.js';
import { LlmRequestError } from './llm-errors.js';
import { OpenAIChatGateway } from './llm-openai-chat-gateway.js';
import { OpenAICodexGateway } from './llm-openai-codex-gateway.js';

export interface LlmProviderGatewayConfig {
  baseUrl: string;
  apiKey?: string;
  registry?: ProviderRegistry;
}

export class LlmProviderGateway implements LlmInvocationClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly registry: ProviderRegistry | undefined;

  constructor(config: LlmProviderGatewayConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.registry = config.registry;
  }

  async complete(
    candidate: Candidate,
    systemPrompt: string,
    messages: AgentMessage[],
    sessionId: string,
    opts: LlmCompleteOptions,
  ): Promise<ProviderTurnCompletion> {
    this.assertCandidateCapabilities(candidate, opts);
    if (candidate.provider === 'openai-codex') {
      return new OpenAICodexGateway({ baseUrl: this.baseUrl, apiKey: this.apiKey }).complete(candidate, systemPrompt, messages, sessionId, opts);
    }
    return new OpenAIChatGateway({ baseUrl: this.baseUrl, apiKey: this.apiKey }).complete(candidate, systemPrompt, messages, sessionId, opts);
  }

  private assertCandidateCapabilities(candidate: Candidate, opts: LlmCompleteOptions): void {
    if (!this.registry) return;
    const tools = opts.phase === 'terminal' ? [opts.terminalToolDefinition] : opts.tools;
    const request = capabilityRequestForLlmOptions({
      tools,
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
        message: `Candidate ${candidateKey(candidate)} does not support requested LLM capabilities: ${match.reasons.join(', ')}`,
      });
    }
  }
}
