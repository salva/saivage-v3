import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import type { LlmCompleteOptions, ProviderConversationProjection, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { executeLlmProviderAttempt } from '../../src/agents/llm-provider-attempt.js';
import { builtInCapabilitiesForProvider, type EffectiveProviderCapabilities } from '../../src/agents/provider-capabilities.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import type { ProviderRegistry } from '../../src/agents/provider.js';

export class LlmPipelineTestClient {
  constructor(private readonly config: { baseUrl: string; apiKey?: string; openAICodexAccountId?: string; registry?: ProviderRegistry; capabilities?: EffectiveProviderCapabilities }) {}

  async complete(candidate: Candidate, systemPrompt: string, providerConversation: ProviderConversationProjection, sessionId: string, options: LlmCompleteOptions): Promise<ProviderTurnCompletion> {
    const configured = this.config.capabilities ?? this.config.registry?.getEffectiveCapabilities(candidate) ?? builtInCapabilitiesForProvider(candidate.provider);
    const capabilities: EffectiveProviderCapabilities = !this.config.capabilities && !this.config.registry && options.stream ? { ...configured, streaming: true } : configured;
    const adapter = selectLlmProtocolAdapter(capabilities.transportProtocol);
    const plan = buildCandidateRequest({ candidate, capabilities, adapter, systemPrompt, providerConversation, options });
    const implicitAccount = { name: '_implicit', models: [candidate.model], apiKey: undefined, baseUrl: undefined, authProfile: undefined };
    const provider = { name: candidate.provider, models: [candidate.model], apiKey: this.config.apiKey, baseUrl: this.config.baseUrl, authProfile: undefined, implicitAccount, getAllAccounts: () => [] };
    const registry = { get: () => provider, getEffectiveCapabilities: () => capabilities } as unknown as ProviderRegistry;
    return executeLlmProviderAttempt({ projectRoot: process.cwd(), registry, sessionId, plan, options });
  }
}
