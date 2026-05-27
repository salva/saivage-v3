import type { AgentMessage } from '../schemas/index.js';
import type { EventLogger } from '../observability/index.js';
import type { LlmCompleteOptions, LlmCallFn, LlmInvocationClient } from './llm-contracts.js';
import { LlmProviderGateway } from './llm-provider-gateway.js';
import type { Candidate, ProviderRegistry } from './provider.js';
import { createLlmExchangeRecorder, toRecorderLogger, type LlmExchangeRecorder } from './llm-exchange-recorder.js';
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
  private readonly recorderCache: Map<string, LlmExchangeRecorder> = new Map();

  constructor(config: AgentLlmInvocationGatewayConfig) {
    this.projectRoot = config.projectRoot;
    this.saivageDir = config.saivageDir;
    this.registry = config.registry;
    this.eventLogger = config.eventLogger;
  }

  private getOrCreateRecorder(sessionId: string): LlmExchangeRecorder {
    let recorder = this.recorderCache.get(sessionId);
    if (!recorder) {
      recorder = createLlmExchangeRecorder({
        saivageDir: this.saivageDir,
        sessionId,
        eventLogger: toRecorderLogger(this.eventLogger),
      });
      this.recorderCache.set(sessionId, recorder);
    }
    return recorder;
  }

  async flushRecorders(): Promise<void> {
    await Promise.all([...this.recorderCache.values()].map((r) => r.flush()));
  }

  createLlmCallFn(): LlmCallFn {
    return async (candidate: Candidate, systemPrompt: string, messages: AgentMessage[], sessionId: string, opts?: LlmCompleteOptions): Promise<string> => {
      const { baseUrl, apiKey, cacheKey } = await resolveLlmTransportConfig(this.projectRoot, this.registry, candidate);
      let client = this.llmClientCache.get(cacheKey);
      if (!client) {
        client = new LlmProviderGateway({ baseUrl, apiKey, registry: this.registry });
        this.llmClientCache.set(cacheKey, client);
      }
      const recorder = this.getOrCreateRecorder(sessionId);
      const result = await client.complete(candidate, systemPrompt, messages, sessionId, { ...opts, recorder });
      return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });
    };
  }
}
