import type { AgentMessage } from '../schemas/index.js';
import type { EventLogger } from '../observability/index.js';
import { parseCompleteInvocationArgs, type LlmCompleteOptions, type ProviderTurnCompletion, type LlmCallFn, type LlmInvocationClient, type ResponsesReplayProjection } from './llm-contracts.js';
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
    return async (candidate: Candidate, systemPrompt: string, genericContextMessages: AgentMessage[], activeConversationReplayOrSessionId: ResponsesReplayProjection | string, sessionIdOrOpts: string | LlmCompleteOptions, maybeOpts?: LlmCompleteOptions): Promise<ProviderTurnCompletion> => {
      const { activeConversationReplay, sessionId, opts } = parseCompleteInvocationArgs(genericContextMessages, activeConversationReplayOrSessionId, sessionIdOrOpts, maybeOpts);
      const { baseUrl, apiKey, openAICodexAccountId } = await resolveLlmTransportConfig(this.projectRoot, this.registry, candidate);
      const client: LlmInvocationClient = new LlmProviderGateway({ baseUrl, apiKey, openAICodexAccountId, registry: this.registry });
      const recorder = this.createRecorder(sessionId);
      return await client.complete(candidate, systemPrompt, genericContextMessages, activeConversationReplay, sessionId, { ...opts, recorder });
    };
  }
}
