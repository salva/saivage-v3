import type { AgentMessage } from '../schemas/index.js';
import type { EventLogger } from '../observability/index.js';
import type { LlmCompleteOptions, ProviderTurnCompletion, LlmCallFn, LlmInvocationClient } from './llm-contracts.js';
import { LlmProviderGateway } from './llm-provider-gateway.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import { createProviderExchangeRecorder, toProviderExchangeRecorderLogger, type ProviderExchangeRecorder } from './provider-exchange-recorder.js';
import { resolveLlmTransportConfig } from './llm-transport.js';

export interface AgentLlmInvocationGatewayConfig {
  projectRoot: string;
  saivageDir: string;
  registry: ProviderRegistry;
  eventLogger?: EventLogger;
}

export class AgentLlmInvocationGateway {
  private readonly projectRoot: string;
  private readonly saivageDir: string;
  private readonly registry: ProviderRegistry;
  private readonly eventLogger?: EventLogger;
  private readonly llmClientCache: Map<string, LlmInvocationClient> = new Map();

  constructor(config: AgentLlmInvocationGatewayConfig) {
    this.projectRoot = config.projectRoot;
    this.saivageDir = config.saivageDir;
    this.registry = config.registry;
    this.eventLogger = config.eventLogger;
  }

  private createRecorder(sessionId: string): ProviderExchangeRecorder {
    return createProviderExchangeRecorder({ sessionId, eventLogger: toProviderExchangeRecorderLogger(this.eventLogger) });
  }

  async flushRecorders(): Promise<void> {
  }

  createLlmCallFn(): LlmCallFn {
    return async (candidate: Candidate, systemPrompt: string, messages: AgentMessage[], sessionId: string, opts: LlmCompleteOptions): Promise<ProviderTurnCompletion> => {
      const { baseUrl, apiKey, cacheKey } = await resolveLlmTransportConfig(this.projectRoot, this.registry, candidate);
      let client = this.llmClientCache.get(cacheKey);
      if (!client) {
        client = new LlmProviderGateway({ baseUrl, apiKey, registry: this.registry });
        this.llmClientCache.set(cacheKey, client);
      }
      const recorder = this.createRecorder(sessionId);
      return await client.complete(candidate, systemPrompt, messages, sessionId, { ...opts, recorder });
    };
  }
}
