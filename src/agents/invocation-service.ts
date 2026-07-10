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
import { ProviderTurnFailure, type LlmCallFn, type ProviderTurnCompletion, type ResponsesReplayProjection, type ToolDefinition } from './llm-contracts.js';
import type { ProviderExchangeAttempt } from '../contracts/provider-exchange.js';
import { AgentLlmInvocationGateway } from './agent-llm-gateway.js';

const INVOCATION_RECOVERY_DELAY_MS = 60_000;
const MAX_INVOCATION_RECOVERY_RETRIES = 3;
const LLM_UNAVAILABILITY_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const WAITABLE_UNAVAILABILITY_REASONS = new Set(['server_transient', 'timeout', 'rate_limit', 'unknown']);

export interface InvocationRequest {
  inputId: string;
  role: OperationalAgentRole;
  sessionId: string;
  systemPrompt: string;
  genericContextMessages?: AgentMessage[];
  activeConversationReplay?: ResponsesReplayProjection;
  contextMessages?: AgentMessage[];
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
      genericContextMessagesForRequest(request),
      activeConversationReplayForRequest(request),
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
    const settled: ProviderExchangeAttempt[] = [];
    let lastTransportError: Error | null = null;
    const deadlineMs = Date.now() + LLM_UNAVAILABILITY_TIMEOUT_MS;

    while (true) {
      throwIfAborted(request.abortSignal);
      const chain = request.candidateChain ?? await this.resolveCandidates(request.role, request.capabilityRequest);
      if (chain.length === 0) this.throwNoCandidates(request, settled);

      for (const candidate of chain) {
        throwIfAborted(request.abortSignal);
        if (!this.candidateAvailability.isAvailable(candidate)) continue;
        try {
          const result = await this.invokeCall(request, candidate);
          await this.candidateAvailability.markSucceeded(candidate);
          return { result: result.result, provider_exchanges: normalizeAttempts(request.inputId, [...settled, ...result.provider_exchanges]), provider_private_context: result.provider_private_context };
        } catch (err) {
          if (isAbortFromSignal(err, request.abortSignal)) throw err;
          const originalFailure = err instanceof ProviderTurnFailure ? err.originalFailure : err;
          if (isAbortFromSignal(originalFailure, request.abortSignal)) throw originalFailure;
          const decision = defaultInvocationRecoveryPolicy.decideFailure(originalFailure, {
            role: request.role,
            candidate,
            attempt: settled.length + 1,
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
          if (decision.action === 'retry_same_after_delay' && decision.retryDelayMs && decision.retryDelayMs > 0) {
            await delayWithAbort(Math.min(decision.retryDelayMs, Math.max(0, deadlineMs - Date.now())), request.abortSignal);
          }
        }
      }

      const wait = this.nextUnavailabilityWaitMs(chain, deadlineMs);
      if (wait === 'timeout') {
        const message = `No LLM candidate became available for role '${request.role}' within ${LLM_UNAVAILABILITY_TIMEOUT_MS}ms.`;
        throw new ProviderTurnFailure({ failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: normalizeAttempts(request.inputId, settled), originalFailure: new Error(message), message });
      }
      if (typeof wait === 'number') {
        if (wait > 0) {
          await delayWithAbort(wait, request.abortSignal);
        }
        continue;
      }

      if (lastTransportError) throw new ProviderTurnFailure({ failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: normalizeAttempts(request.inputId, settled), originalFailure: lastTransportError });
      throw new ProviderTurnFailure({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: new Error(`No healthy candidates available for role '${request.role}'.`) });
    }
  }

  async flushRecorders(): Promise<void> {
    await this.llmGateway.flushRecorders();
  }

  private throwNoCandidates(request: InvocationRequest, settled: ProviderExchangeAttempt[]): never {
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
    throw new ProviderTurnFailure({ failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: normalizeAttempts(request.inputId, settled), originalFailure: new Error(decision.message), message: decision.message });
  }

  private nextUnavailabilityWaitMs(chain: Candidate[], deadlineMs: number): number | 'timeout' | null {
    const now = Date.now();
    if (chain.some((candidate) => this.candidateAvailability.isAvailable(candidate))) return null;
    let earliestFuture: number | null = null;
    let hasWaitableTemporary = false;
    for (const candidate of chain) {
      const entry = this.candidateAvailability.getEntry(candidate);
      if (!entry || entry.state === 'HEALTHY') continue;
      if (!entry.reason || !WAITABLE_UNAVAILABILITY_REASONS.has(entry.reason)) continue;
      hasWaitableTemporary = true;
      if (entry.untilMs > now) earliestFuture = earliestFuture === null ? entry.untilMs : Math.min(earliestFuture, entry.untilMs);
    }
    if (!hasWaitableTemporary) return null;
    const remainingMs = deadlineMs - now;
    if (remainingMs <= 0) return 'timeout';
    if (earliestFuture === null) return 0;
    return Math.min(Math.max(0, earliestFuture - now), remainingMs);
  }
}

function delayWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  if (typeof DOMException !== 'undefined') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortFromSignal(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof Error && error.name === 'AbortError';
}

function normalizeAttempts(sourceInputId: string, attempts: ProviderExchangeAttempt[]): ProviderExchangeAttempt[] {
  return attempts.map((attempt, index) => ({ ...attempt, source_input_id: sourceInputId, attempt_index: index }));
}

function genericContextMessagesForRequest(request: InvocationRequest): AgentMessage[] {
  const messages = request.genericContextMessages ?? request.contextMessages;
  if (!messages) throw new Error(`Invocation '${request.inputId}' is missing genericContextMessages.`);
  return messages;
}

function activeConversationReplayForRequest(request: InvocationRequest): ResponsesReplayProjection {
  if (request.activeConversationReplay) return request.activeConversationReplay;
  const messages = genericContextMessagesForRequest(request);
  return { sessionId: request.sessionId, messages };
}
