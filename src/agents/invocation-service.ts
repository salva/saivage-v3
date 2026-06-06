import type { AgentMessage, OperationalAgentRole } from '../schemas/index.js';
import type { EventLogger } from '../observability/index.js';
import { buildLlmOptions } from './llm-options-factory.js';
import type { Candidate, ProviderRegistry } from './provider.js';
import type { ModelRouter } from './model-router.js';
import {
  type CandidateAvailability,
  MemoryCandidateAvailability,
} from './candidate-availability.js';
import type { CapabilityRequest } from './provider-capabilities.js';
import { defaultInvocationRecoveryPolicy } from './invocation-recovery-policy.js';
import type { LlmCallFn, LlmCompleteResult, ToolDefinition } from './llm-contracts.js';
import { AgentLlmInvocationGateway } from './agent-llm-gateway.js';

export interface InvocationRequest {
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
  recoveryDelayMs?: number;
  maxRecoveryRetries?: number;
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
    this.recoveryDelayMs = config.recoveryDelayMs ?? 60000;
    this.maxRecoveryRetries = config.maxRecoveryRetries ?? 3;
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

  async invokeCall(request: InvocationRequest, candidate: Candidate): Promise<LlmCompleteResult> {
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
        undefined,
      ),
    );
  }

  async invokeWithRecovery(request: InvocationRequest): Promise<LlmCompleteResult> {
    const chain = request.candidateChain ?? await this.resolveCandidates(request.role, request.capabilityRequest);
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
      throw new Error(decision.message);
    }

    let lastTransportError: Error | null = null;
    for (const candidate of chain) {
      if (!this.candidateAvailability.isAvailable(candidate)) continue;
      try {
        const result = await this.invokeCall(request, candidate);
        await this.candidateAvailability.markSucceeded(candidate);
        return result;
      } catch (err) {
        const decision = defaultInvocationRecoveryPolicy.decideFailure(err, {
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
        if (decision.markFailed && decision.availability) await this.candidateAvailability.markFailed(candidate, decision.availability);
        if (decision.action === 'abort_without_retry' || decision.action === 'fail_invocation') throw err;
        lastTransportError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (lastTransportError) throw lastTransportError;
    throw new Error(`No healthy candidates available for role '${request.role}'.`);
  }

  async flushRecorders(): Promise<void> {
    await this.llmGateway.flushRecorders();
  }
}
