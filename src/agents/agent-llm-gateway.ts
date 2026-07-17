import type { EventLog } from '../observability/index.js';
import type { LlmCompleteOptions, ProviderConversationProjection, ProviderTurnCompletion, LlmCallFn, LlmInvocationClient } from './llm-contracts.js';
import { LlmProviderGateway } from './llm-provider-gateway.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import { createProviderExchangeRecorder, toProviderExchangeRecorderLogger, type ProviderExchangeRecorder } from './provider-exchange-recorder.js';
import { resolveLlmTransportConfig } from './llm-transport.js';
import { createHash } from 'node:crypto';

export interface AgentLlmInvocationGatewayConfig {
  projectRoot: string;
  saivageDir: string;
  registry: ProviderRegistry;
  eventLogger?: EventLog;
}

export class AgentLlmInvocationGateway {
  private readonly projectRoot: string;
  private readonly saivageDir: string;
  private readonly registry: ProviderRegistry;
  private readonly eventLogger?: EventLog;

  constructor(config: AgentLlmInvocationGatewayConfig) {
    this.projectRoot = config.projectRoot;
    this.saivageDir = config.saivageDir;
    this.registry = config.registry;
    this.eventLogger = config.eventLogger;
  }

  private createRecorder(sessionId: string): ProviderExchangeRecorder {
    return createProviderExchangeRecorder({ sessionId, eventLogger: toProviderExchangeRecorderLogger(this.eventLogger) });
  }

  createLlmCallFn(): LlmCallFn {
    return async (candidate: Candidate, systemPrompt: string, providerConversation: ProviderConversationProjection, sessionId: string, opts: LlmCompleteOptions): Promise<ProviderTurnCompletion> => {
      if (opts.builtCandidateRequest && createHash('sha256').update(opts.builtCandidateRequest.serializedBody, 'utf8').digest('hex') !== opts.builtCandidateRequest.requestHash) throw new Error('Built candidate request changed between admission and send.');
      const { baseUrl, apiKey, openAICodexAccountId } = await resolveLlmTransportConfig(this.projectRoot, this.registry, candidate, opts.signal);
      const client: LlmInvocationClient = new LlmProviderGateway({ baseUrl, apiKey, openAICodexAccountId, registry: this.registry });
      const recorder = this.createRecorder(sessionId);
      return await client.complete(candidate, systemPrompt, providerConversation, sessionId, { ...opts, recorder });
    };
  }
}
