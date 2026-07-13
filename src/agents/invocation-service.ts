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
import { readProviderExchangeLogEntries } from '../persistence/provider-exchange-log.js';
import type { ProviderExchangeMutationPort } from '../persistence/provider-exchange-mutation-port.js';
import type { MutationAuthority } from '../application/mutation-authority.js';
import type { AuthProfileRepository } from '../auth/auth-profile-store.js';

const INVOCATION_RECOVERY_DELAY_MS = 60_000;
const MAX_INVOCATION_RECOVERY_RETRIES = 3;
const LLM_UNAVAILABILITY_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const WAITABLE_UNAVAILABILITY_REASONS = new Set(['server_transient', 'timeout', 'rate_limit', 'unknown', 'parse_error']);

type CandidateRecoveryState = 'UNTRIED' | 'RETRY_WAITING_UNTIL' | 'RETRYABLE_READY' | 'RATE_LIMIT_WAITING_UNTIL' | 'RATE_LIMIT_READY' | 'EXHAUSTED';

interface CandidateRecoveryRecord {
  candidate: Candidate;
  attempts: number;
  state: CandidateRecoveryState;
  untilMs?: number;
  lastFailure?: unknown;
}

export interface InvocationRequest {
  mutationAuthority: MutationAuthority;
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
  providerExchangeMutations: ProviderExchangeMutationPort;
  authProfiles: AuthProfileRepository;
}

export class InvocationService {
  private readonly router: ModelRouter;
  private readonly projectRoot: string;
  private readonly candidateAvailability: CandidateAvailability;
  private readonly recoveryDelayMs: number;
  private readonly maxRecoveryRetries: number;
  private readonly llmGateway: AgentLlmInvocationGateway;
  private readonly llmCallFn?: LlmCallFn;
  private readonly providerExchangeMutations: ProviderExchangeMutationPort;

  constructor(config: InvocationServiceConfig) {
    this.projectRoot = config.projectRoot;
    this.router = config.router;
    this.candidateAvailability = config.candidateAvailability ?? new MemoryCandidateAvailability();
    this.recoveryDelayMs = INVOCATION_RECOVERY_DELAY_MS;
    this.maxRecoveryRetries = MAX_INVOCATION_RECOVERY_RETRIES;
    this.llmGateway = new AgentLlmInvocationGateway({
      projectRoot: config.projectRoot,
      saivageDir: config.saivageDir,
      registry: config.registry,
      eventLogger: config.eventLogger,
      authProfiles: config.authProfiles,
    });
    this.llmCallFn = config.llmCallFn;
    this.providerExchangeMutations = config.providerExchangeMutations;
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
      request.mutationAuthority,
    );
  }

  async invokeWithRecovery(request: InvocationRequest): Promise<ProviderTurnCompletion> {
    const persisted = new ProviderExchangeAppender(this.projectRoot, request.sessionId, request.inputId, this.providerExchangeMutations);
    const settled: ProviderExchangeAttempt[] = [];
    let lastFailure: unknown = null;
    const deadlineMs = Date.now() + LLM_UNAVAILABILITY_TIMEOUT_MS;
    const chain = request.candidateChain ?? await this.resolveCandidates(request.role, request.capabilityRequest);
    if (chain.length === 0) this.throwNoCandidates(request, settled);
    const states: CandidateRecoveryRecord[] = chain.map((candidate) => ({ candidate, attempts: 0, state: 'UNTRIED' }));

    while (true) {
      throwIfAborted(request.abortSignal);
      updateReadyStates(states);
      const next = this.nextCandidateState(states, deadlineMs);
      if (next.kind === 'timeout') {
        const message = `No LLM candidate became available for role '${request.role}' within ${LLM_UNAVAILABILITY_TIMEOUT_MS}ms.`;
        throw new ProviderTurnFailure({ failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: settled, originalFailure: lastFailure ?? new Error(message), message });
      }
      if (next.kind === 'wait') {
        await delayWithAbort(next.waitMs, request.abortSignal);
        continue;
      }
      if (next.kind === 'none') {
        const originalFailure = lastFailure ?? new Error(`No healthy candidates available for role '${request.role}'.`);
        throw new ProviderTurnFailure({ failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: settled, originalFailure });
      }

      const record = next.record;
      const candidate = record.candidate;
      if (!this.candidateAvailability.isAvailable(candidate)) {
        record.state = 'EXHAUSTED';
        continue;
      }
        try {
          const result = await this.invokeCall(request, candidate);
          const persistedAttempts = persisted.appendAll(result.provider_exchanges);
          settled.push(...persistedAttempts);
          await this.candidateAvailability.markSucceeded(candidate);
          return { result: result.result, provider_exchanges: settled, provider_private_context: result.provider_private_context };
        } catch (err) {
          if (isAbortFromSignal(err, request.abortSignal)) throw err;
          const originalFailure = err instanceof ProviderTurnFailure ? err.originalFailure : err;
          if (isAbortFromSignal(originalFailure, request.abortSignal)) throw originalFailure;
          record.attempts += 1;
          const decision = defaultInvocationRecoveryPolicy.decideFailure(originalFailure, {
            role: request.role,
            candidate,
            attempt: record.attempts,
            maxAttempts: 1 + this.maxRecoveryRetries,
            recoveryDelayMs: this.recoveryDelayMs,
            maxRecoveryRetries: this.maxRecoveryRetries,
            capabilityRequest: request.capabilityRequest,
            capabilitySkips: this.router.getLastCapabilitySkips(),
            sessionId: request.sessionId,
          });
          if (err instanceof ProviderTurnFailure && err.failure_phase === 'provider_attempt') {
            if (err.provider_exchanges.length === 0) throw new Error(`Provider attempt for input '${request.inputId}' settled without a provider_exchange envelope.`);
            settled.push(...persisted.appendAll(err.provider_exchanges));
          }
          if (decision.markFailed && decision.availability) await this.candidateAvailability.markFailed(candidate, decision.availability);
          if (decision.action === 'abort_without_retry' || decision.action === 'fail_invocation') {
            throw new ProviderTurnFailure({
              failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider',
              provider_exchanges: settled,
              originalFailure,
            });
          }
          lastFailure = originalFailure;
          const hasBudget = record.attempts < 1 + this.maxRecoveryRetries;
          if (!hasBudget) {
            record.state = 'EXHAUSTED';
            continue;
          }
          if (decision.failure?.kind === 'rate_limit') {
            record.state = 'RATE_LIMIT_WAITING_UNTIL';
            record.untilMs = decision.availability?.untilMs ?? Date.now() + Math.max(this.recoveryDelayMs, 60_000);
          } else if (decision.failure?.kind === 'server_transient' || decision.failure?.kind === 'timeout' || decision.failure?.kind === 'unknown' || decision.failure?.kind === 'parse_error') {
            record.state = 'RETRY_WAITING_UNTIL';
            record.untilMs = Date.now() + (decision.retryDelayMs ?? this.recoveryDelayMs);
          } else {
            throw new ProviderTurnFailure({ failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: settled, originalFailure });
          }
          record.lastFailure = originalFailure;
        }
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
    throw new ProviderTurnFailure({ failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: settled, originalFailure: new Error(decision.message), message: decision.message });
  }

  private nextCandidateState(states: CandidateRecoveryRecord[], deadlineMs: number): { kind: 'attempt'; record: CandidateRecoveryRecord } | { kind: 'wait'; waitMs: number } | { kind: 'timeout' } | { kind: 'none' } {
    const now = Date.now();
    const retryWaiting = states.find((s) => s.state === 'RETRY_WAITING_UNTIL');
    if (retryWaiting) return waitUntil(retryWaiting.untilMs ?? now, now, deadlineMs);
    const retryReady = states.find((s) => s.state === 'RETRYABLE_READY');
    if (retryReady) return { kind: 'attempt', record: retryReady };
    const untried = states.find((s) => s.state === 'UNTRIED' && this.candidateAvailability.isAvailable(s.candidate));
    if (untried) return { kind: 'attempt', record: untried };
    const rateReady = states.find((s) => s.state === 'RATE_LIMIT_READY');
    if (rateReady) return { kind: 'attempt', record: rateReady };
    const waitingUntil = states
      .filter((s) => s.state === 'RATE_LIMIT_WAITING_UNTIL')
      .map((s) => s.untilMs ?? now)
      .sort((a, b) => a - b)[0];
    if (waitingUntil !== undefined) return waitUntil(waitingUntil, now, deadlineMs);
    for (const state of states) {
      const entry = this.candidateAvailability.getEntry(state.candidate);
      if (!entry || entry.state === 'HEALTHY') continue;
      if (entry.reason && WAITABLE_UNAVAILABILITY_REASONS.has(entry.reason)) return waitUntil(entry.untilMs, now, deadlineMs);
    }
    return { kind: 'none' };
  }
}

function waitUntil(untilMs: number, now: number, deadlineMs: number): { kind: 'wait'; waitMs: number } | { kind: 'timeout' } {
  const remainingMs = deadlineMs - now;
  if (remainingMs <= 0) return { kind: 'timeout' };
  return { kind: 'wait', waitMs: Math.min(Math.max(0, untilMs - now), remainingMs) };
}

function updateReadyStates(states: CandidateRecoveryRecord[]): void {
  const now = Date.now();
  for (const state of states) {
    if (state.state === 'RETRY_WAITING_UNTIL' && (state.untilMs ?? 0) <= now) state.state = 'RETRYABLE_READY';
    if (state.state === 'RATE_LIMIT_WAITING_UNTIL' && (state.untilMs ?? 0) <= now) state.state = 'RATE_LIMIT_READY';
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

class ProviderExchangeAppender {
  private nextAttemptIndex: number;
  private readonly identities = new Set<string>();

  constructor(private readonly projectRoot: string, private readonly sessionId: string, private readonly sourceInputId: string, private readonly mutations: ProviderExchangeMutationPort) {
    const existing = readProviderExchangeLogEntries(projectRoot, sessionId).filter((entry) => entry.source_input_id === sourceInputId);
    for (const entry of existing) this.identities.add(this.identity(entry.attempt_index));
    this.nextAttemptIndex = existing.length === 0 ? 0 : Math.max(...existing.map((entry) => entry.attempt_index)) + 1;
  }

  appendAll(attempts: ProviderExchangeAttempt[]): ProviderExchangeAttempt[] {
    return attempts.map((attempt) => this.append(attempt));
  }

  private append(attempt: ProviderExchangeAttempt): ProviderExchangeAttempt {
    const indexed = { ...attempt, source_input_id: this.sourceInputId, attempt_index: this.nextAttemptIndex++ };
    const identity = this.identity(indexed.attempt_index);
    if (this.identities.has(identity)) throw new Error(`Duplicate provider_exchange identity '${identity}'.`);
    this.identities.add(identity);
    const payload = indexed.status === 'ok'
      ? { ...indexed, assistant_output_ids: [] }
      : indexed;
    this.mutations.append({
      session_id: this.sessionId,
      source_input_id: this.sourceInputId,
      attempt_index: indexed.attempt_index,
      timestamp: indexed.completed_at,
      payload,
    });
    return indexed;
  }

  private identity(attemptIndex: number): string {
    return `${this.sessionId}:${this.sourceInputId}:${attemptIndex}`;
  }
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
