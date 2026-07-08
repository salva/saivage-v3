import type { AgentMessage, OperationalAgentRole } from '../schemas/index.js';
import type { EventLogger } from '../observability/index.js';
import { buildLlmOptions } from './llm-options-factory.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import type { ModelRouter } from './model-router.js';
import {
  type CandidateAvailability,
  MemoryCandidateAvailability,
} from './candidate-availability.js';
import type { CapabilityRequest } from './provider-capabilities.js';
import { defaultInvocationRecoveryPolicy } from './invocation-recovery-policy.js';
import { ProviderTurnFailure, type LlmCallFn, type ProviderTurnCompletion, type ToolDefinition } from './llm-contracts.js';
import type { ProviderExchangeAttempt } from '../contracts/provider-exchange.js';
import { AgentLlmInvocationGateway } from './agent-llm-gateway.js';

const INVOCATION_RECOVERY_DELAY_MS = 60_000;
const MAX_INVOCATION_RECOVERY_RETRIES = 3;

export interface InvocationRequest {
  inputId: string;
  role: OperationalAgentRole;
  sessionId: string;
  systemPrompt: string;
  contextMessages: AgentMessage[];
  tools: ToolDefinition[];
  terminalToolNames: string[];
  modelParams: { temperature?: number; maxTokens?: number };
  capabilityRequest: CapabilityRequest;
  abortSignal?: AbortSignal;
  candidateChain?: Candidate[];
}

export interface InvocationServiceConfig {
  projectRoot: string;
  saivageDir: string;
  registry: ProviderRegistry;
  router: ModelRouter;
  eventLogger?: EventLogger;
  candidateAvailability?: CandidateAvailability;
  llmCallFn?: LlmCallFn;
}

export class InvocationService {
  private readonly router: ModelRouter;
  private readonly candidateAvailability: CandidateAvailability;
  private readonly recoveryDelayMs: number;
  private readonly maxRecoveryRetries: number;
  private readonly llmGateway: AgentLlmInvocationGateway;
  private readonly llmCallFn?: LlmCallFn;

  constructor(config: InvocationServiceConfig) {
    this.router = config.router;
    this.candidateAvailability = config.candidateAvailability ?? new MemoryCandidateAvailability();
    this.recoveryDelayMs = INVOCATION_RECOVERY_DELAY_MS;
    this.maxRecoveryRetries = MAX_INVOCATION_RECOVERY_RETRIES;
    this.llmGateway = new AgentLlmInvocationGateway({
      projectRoot: config.projectRoot,
      saivageDir: config.saivageDir,
      registry: config.registry,
      eventLogger: config.eventLogger,
    });
    this.llmCallFn = config.llmCallFn;
  }

  async resolveCandidates(role: OperationalAgentRole, capabilityRequest: CapabilityRequest): Promise<Candidate[]> {
    return this.router.resolve(role, capabilityRequest);
  }

  async invokeCall(request: InvocationRequest, candidate: Candidate): Promise<ProviderTurnCompletion> {
    const call = this.llmCallFn ?? this.llmGateway.createLlmCallFn();
    return call(
      candidate,
      request.systemPrompt,
      request.contextMessages,
      request.sessionId,
      buildLlmOptions(
        request.role,
        request.tools,
        request.terminalToolNames,
        { temperature: request.modelParams.temperature, max_tokens: request.modelParams.maxTokens },
        request.abortSignal,
        request.inputId,
        undefined,
      ),
    );
  }

  async invokeWithRecovery(request: InvocationRequest): Promise<ProviderTurnCompletion> {
    const chain = request.candidateChain ?? await this.resolveCandidates(request.role, request.capabilityRequest);
    const settled: ProviderExchangeAttempt[] = [];
    if (chain.length === 0) {
      const decision = defaultInvocationRecoveryPolicy.decideNoCandidates({
        role: request.role,
        attempt: 1,
        maxAttempts: 1,
        recoveryDelayMs: this.recoveryDelayMs,
        maxRecoveryRetries: this.maxRecoveryRetries,
        capabilityRequest: request.capabilityRequest,
        capabilitySkips: this.router.getLastCapabilitySkips(),
        sessionId: request.sessionId,
      });
      throw new ProviderTurnFailure({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: new Error(decision.message), message: decision.message });
    }

    let lastTransportError: Error | null = null;
    for (const candidate of chain) {
      if (!this.candidateAvailability.isAvailable(candidate)) continue;
      try {
        const result = await this.invokeCall(request, candidate);
        await this.candidateAvailability.markSucceeded(candidate);
        return { result: result.result, provider_exchanges: normalizeAttempts(request.inputId, [...settled, ...result.provider_exchanges]) };
      } catch (err) {
        const originalFailure = err instanceof ProviderTurnFailure ? err.originalFailure : err;
        const decision = defaultInvocationRecoveryPolicy.decideFailure(originalFailure, {
          role: request.role,
          candidate,
          attempt: 1,
          maxAttempts: chain.length,
          recoveryDelayMs: this.recoveryDelayMs,
          maxRecoveryRetries: this.maxRecoveryRetries,
          capabilityRequest: request.capabilityRequest,
          capabilitySkips: this.router.getLastCapabilitySkips(),
          sessionId: request.sessionId,
        });
        if (err instanceof ProviderTurnFailure && err.failure_phase === 'provider_attempt') {
          if (err.provider_exchanges.length === 0) throw new Error(`Provider attempt for input '${request.inputId}' settled without a provider_exchange envelope.`);
          settled.push(...err.provider_exchanges);
        }
        if (decision.markFailed && decision.availability) await this.candidateAvailability.markFailed(candidate, decision.availability);
        if (decision.action === 'abort_without_retry' || decision.action === 'fail_invocation') {
          throw new ProviderTurnFailure({
            failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider',
            provider_exchanges: normalizeAttempts(request.inputId, settled),
            originalFailure,
          });
        }
        lastTransportError = originalFailure instanceof Error ? originalFailure : new Error(String(originalFailure));
      }
    }

    if (lastTransportError) throw new ProviderTurnFailure({ failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: normalizeAttempts(request.inputId, settled), originalFailure: lastTransportError });
    throw new ProviderTurnFailure({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: new Error(`No healthy candidates available for role '${request.role}'.`) });
  }

  async flushRecorders(): Promise<void> {
    await this.llmGateway.flushRecorders();
  }
}

function normalizeAttempts(sourceInputId: string, attempts: ProviderExchangeAttempt[]): ProviderExchangeAttempt[] {
  return attempts.map((attempt, index) => ({ ...attempt, source_input_id: sourceInputId, attempt_index: index }));
}
