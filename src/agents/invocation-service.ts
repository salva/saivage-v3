import { ConversationSessionIdSchema, type OperationalAgentRole } from '../schemas/index.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import { buildLlmOptions } from './llm-options-factory.js';
import { candidatesEqual, type Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import type { ModelRouter } from './model-router.js';
import type { CandidateAvailability } from './candidate-availability.js';
import type { CapabilityRequest } from './provider-capabilities.js';
import { defaultInvocationRecoveryPolicy } from './invocation-recovery-policy.js';
import {
  assertProviderConversationSourceRows,
  ProviderTurnFailure,
  type ProviderConversationProjection,
  type ProviderTurnCompletion,
  type ToolDefinition,
} from './llm-contracts.js';
import type { ProviderExchangeAttempt } from '../contracts/provider-exchange.js';
import { providerExchangeAppLogEntry } from '../persistence/provider-exchange-log.js';
import { appendAppLogEntry, type AppLogContext } from '../persistence/app-log.js';
import {
  buildCandidateRequest,
  CandidateRequestPlanIntegrityError,
  type CandidateRequestPlan,
} from './candidate-request.js';
import type { PreparedCompaction } from '../runtime/actors/llm-invocation.js';
import { projectProviderExchangeForPublication } from './provider-exchange-projection.js';
import { selectLlmProtocolAdapter } from './llm-protocol-adapter.js';
import { executeLlmProviderAttempt } from './llm-provider-attempt.js';

const INVOCATION_RECOVERY_DELAY_MS = 60_000;
const MAX_INVOCATION_RECOVERY_RETRIES = 3;
const LLM_UNAVAILABILITY_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const WAITABLE_UNAVAILABILITY_REASONS = new Set([
  'server_transient',
  'timeout',
  'rate_limit',
  'unknown',
  'parse_error',
]);

type CandidateRecoveryState =
  | 'UNTRIED'
  | 'RETRY_WAITING_UNTIL'
  | 'RETRYABLE_READY'
  | 'RATE_LIMIT_WAITING_UNTIL'
  | 'RATE_LIMIT_READY'
  | 'EXHAUSTED';

interface CandidateRecoveryRecord {
  candidate: Candidate;
  attempts: number;
  state: CandidateRecoveryState;
  untilMs?: number;
  lastFailure?: unknown;
}

interface InvocationRequestBase {
  inputId: string;
  role: OperationalAgentRole;
  sessionId: string;
  systemPrompt: string;
  providerConversation: ProviderConversationProjection;
  tools: ToolDefinition[];
  terminalToolNames: string[];
  capabilityRequest: CapabilityRequest;
  abortSignal?: AbortSignal;
  candidateChain?: Candidate[];
}

export type InvocationRequest = InvocationRequestBase &
  (
    | {
        preparedCompaction: PreparedCompaction;
        modelParams: { temperature?: number; maxTokens?: never };
      }
    | { preparedCompaction?: never; modelParams: { temperature?: number; maxTokens?: number } }
  );

export interface InvocationServiceConfig {
  projectRoot: string;
  registry: ProviderRegistry;
  router: ModelRouter;
  candidateAvailability: CandidateAvailability;
  appLogs: AppLogContext;
  readModelChanges: ReadModelChanges;
}

export class InvocationService {
  private readonly router: ModelRouter;
  private readonly projectRoot: string;
  private readonly candidateAvailability: CandidateAvailability;
  private readonly recoveryDelayMs: number;
  private readonly maxRecoveryRetries: number;
  private readonly appLogs: AppLogContext;
  private readonly registry: ProviderRegistry;
  private readonly readModelChanges: ReadModelChanges;

  constructor(config: InvocationServiceConfig) {
    this.projectRoot = config.projectRoot;
    this.registry = config.registry;
    this.router = config.router;
    this.candidateAvailability = config.candidateAvailability;
    this.recoveryDelayMs = INVOCATION_RECOVERY_DELAY_MS;
    this.maxRecoveryRetries = MAX_INVOCATION_RECOVERY_RETRIES;
    this.appLogs = config.appLogs;
    this.readModelChanges = config.readModelChanges;
  }

  async resolveCandidates(
    role: OperationalAgentRole,
    capabilityRequest: CapabilityRequest,
  ): Promise<Candidate[]> {
    return this.router.resolve(role, capabilityRequest);
  }

  async invokeCall(
    request: InvocationRequest,
    candidate: Candidate,
    plans?: Array<{ candidate: Candidate; plan: CandidateRequestPlan }>,
  ): Promise<ProviderTurnCompletion> {
    assertProviderConversationSourceRows(request.providerConversation);
    const outputTokens =
      request.preparedCompaction?.requestedCompletionTokens ?? request.modelParams.maxTokens;
    const options = buildLlmOptions(
      request.role,
      request.tools,
      request.terminalToolNames,
      { temperature: request.modelParams.temperature, max_tokens: outputTokens },
      request.abortSignal,
      request.inputId,
    );
    let plan = plans?.find((entry) => candidatesEqual(entry.candidate, candidate))?.plan;
    if (!plan) {
      const capabilities = this.registry.getEffectiveCapabilities(candidate);
      const adapter = selectLlmProtocolAdapter(capabilities.transportProtocol);
      plan = buildCandidateRequest({
        candidate,
        capabilities,
        adapter,
        systemPrompt: request.systemPrompt,
        providerConversation: request.providerConversation,
        options,
      });
      plans?.push({ candidate, plan });
    }
    if (request.preparedCompaction) {
      const requestedCompletionTokens = request.preparedCompaction.requestedCompletionTokens;
      const reason = candidateAdmissionFailure(
        plan.capabilities,
        plan.request.estimatedWireInputTokens,
        requestedCompletionTokens,
      );
      if (reason)
        throw new CandidateAdmissionError(
          candidate,
          plan.capabilities.transportProtocol,
          plan.request.estimatedWireInputTokens,
          requestedCompletionTokens,
          plan.capabilities.contextWindowTokens,
          plan.capabilities.maxOutputTokens,
          reason,
        );
    }
    return executeLlmProviderAttempt({
      projectRoot: this.projectRoot,
      registry: this.registry,
      sessionId: request.sessionId,
      plan,
      options,
    });
  }

  async invokeWithRecovery(request: InvocationRequest): Promise<ProviderTurnCompletion> {
    const settled: ProviderExchangeAttempt[] = [];
    let lastFailure: unknown = null;
    const deadlineMs = Date.now() + LLM_UNAVAILABILITY_TIMEOUT_MS;
    const chain =
      request.candidateChain ??
      (await this.resolveCandidates(request.role, request.capabilityRequest));
    if (chain.length === 0) this.throwNoCandidates(request, settled);
    const states: CandidateRecoveryRecord[] = chain.map((candidate) => ({
      candidate,
      attempts: 0,
      state: 'UNTRIED',
    }));
    const plans: Array<{ candidate: Candidate; plan: CandidateRequestPlan }> = [];

    for (;;) {
      throwIfAborted(request.abortSignal);
      updateReadyStates(states);
      const next = this.nextCandidateState(states, deadlineMs);
      if (next.kind === 'timeout') {
        const message = `No LLM candidate became available for role '${request.role}' within ${LLM_UNAVAILABILITY_TIMEOUT_MS}ms.`;
        throw new ProviderTurnFailure({
          failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider',
          provider_exchanges: settled,
          originalFailure: lastFailure ?? new Error(message),
          message,
        });
      }
      if (next.kind === 'wait') {
        await delayWithAbort(next.waitMs, request.abortSignal);
        continue;
      }
      if (next.kind === 'none') {
        const originalFailure =
          lastFailure ?? new Error(`No healthy candidates available for role '${request.role}'.`);
        throw new ProviderTurnFailure({
          failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider',
          provider_exchanges: settled,
          originalFailure,
        });
      }

      const record = next.record;
      const candidate = record.candidate;
      if (!this.candidateAvailability.isAvailable(candidate)) {
        record.state = 'EXHAUSTED';
        continue;
      }
      try {
        const result = await this.invokeCall(request, candidate, plans);
        settled.push(
          ...indexProviderExchangeAttempts(
            request.inputId,
            settled.length,
            result.provider_exchanges,
          ),
        );
        throwIfAborted(request.abortSignal);
        this.candidateAvailability.markSucceeded(candidate);
        return {
          result: result.result,
          provider_exchanges: settled,
          provider_private_context: result.provider_private_context,
        };
      } catch (err) {
        if (err instanceof CandidateRequestPlanIntegrityError) throw err;
        if (err instanceof CandidateAdmissionError) {
          record.state = 'EXHAUSTED';
          lastFailure = err;
          continue;
        }
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
          if (err.provider_exchanges.length === 0)
            throw new Error(
              `Provider attempt for input '${request.inputId}' settled without a provider_exchange envelope.`,
            );
          settled.push(
            ...indexProviderExchangeAttempts(
              request.inputId,
              settled.length,
              err.provider_exchanges,
            ),
          );
        }
        if (decision.markFailed && decision.availability) {
          throwIfAborted(request.abortSignal);
          this.candidateAvailability.markFailed(candidate, decision.availability);
        }
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
          record.untilMs =
            decision.availability?.untilMs ?? Date.now() + Math.max(this.recoveryDelayMs, 60_000);
        } else if (
          decision.failure?.kind === 'server_transient' ||
          decision.failure?.kind === 'timeout' ||
          decision.failure?.kind === 'unknown' ||
          decision.failure?.kind === 'parse_error'
        ) {
          record.state = 'RETRY_WAITING_UNTIL';
          record.untilMs = Date.now() + (decision.retryDelayMs ?? this.recoveryDelayMs);
        } else {
          throw new ProviderTurnFailure({
            failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider',
            provider_exchanges: settled,
            originalFailure,
          });
        }
        record.lastFailure = originalFailure;
      }
    }
  }

  projectProviderExchanges(
    sessionId: string,
    sourceInputId: string,
    attempts: ProviderExchangeAttempt[],
    assistantOutputIds: string[],
  ): void {
    for (const attempt of attempts) {
      if (attempt.attempt_index === undefined)
        throw new Error(`Provider exchange for '${sourceInputId}' is missing attempt_index.`);
      if (attempt.source_input_id !== sourceInputId)
        throw new Error(
          `Provider exchange source_input_id '${attempt.source_input_id}' does not match '${sourceInputId}'.`,
        );
      const payload = projectProviderExchangeForPublication(
        attempt as ProviderExchangeAttempt & { attempt_index: number },
        assistantOutputIds,
      );
      appendAppLogEntry(
        this.appLogs.projectRoot,
        providerExchangeAppLogEntry({
          session_id: sessionId,
          source_input_id: sourceInputId,
          attempt_index: attempt.attempt_index,
          timestamp: attempt.completed_at,
          payload,
        }),
      );
      if (ConversationSessionIdSchema.safeParse(sessionId).success)
        this.readModelChanges.agentsChanged();
    }
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
    throw new ProviderTurnFailure({
      failure_phase: settled.length > 0 ? 'provider_attempt' : 'pre_provider',
      provider_exchanges: settled,
      originalFailure: new Error(decision.message),
      message: decision.message,
    });
  }

  private nextCandidateState(
    states: CandidateRecoveryRecord[],
    deadlineMs: number,
  ):
    | { kind: 'attempt'; record: CandidateRecoveryRecord }
    | { kind: 'wait'; waitMs: number }
    | { kind: 'timeout' }
    | { kind: 'none' } {
    const now = Date.now();
    const retryWaiting = states.find((s) => s.state === 'RETRY_WAITING_UNTIL');
    if (retryWaiting) return waitUntil(retryWaiting.untilMs ?? now, now, deadlineMs);
    const retryReady = states.find((s) => s.state === 'RETRYABLE_READY');
    if (retryReady) return { kind: 'attempt', record: retryReady };
    const untried = states.find(
      (s) => s.state === 'UNTRIED' && this.candidateAvailability.isAvailable(s.candidate),
    );
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
      if (entry.reason && WAITABLE_UNAVAILABILITY_REASONS.has(entry.reason))
        return waitUntil(entry.untilMs, now, deadlineMs);
    }
    return { kind: 'none' };
  }
}

type AdmissionReason =
  | 'missing_context_window'
  | 'missing_max_output'
  | 'context_window_too_small'
  | 'max_output_too_small';
function candidateAdmissionFailure(
  capabilities: ReturnType<ProviderRegistry['getEffectiveCapabilities']>,
  estimated: number,
  requested: number,
): AdmissionReason | null {
  if (capabilities.contextWindowTokens === undefined) return 'missing_context_window';
  if (capabilities.maxOutputTokens === undefined) return 'missing_max_output';
  if (requested > capabilities.maxOutputTokens) return 'max_output_too_small';
  if (estimated + requested > capabilities.contextWindowTokens) return 'context_window_too_small';
  return null;
}

class CandidateAdmissionError extends Error {
  constructor(
    candidate: Candidate,
    protocol: string,
    estimated: number,
    requested: number,
    context: number | undefined,
    output: number | undefined,
    reason: AdmissionReason,
  ) {
    const deficit = context === undefined ? null : Math.max(0, estimated + requested - context);
    super(
      `Compacted candidate skipped: protocol=${protocol}, candidate=${candidate.provider}/${candidate.account ?? '_implicit'}/${candidate.model}, estimated_wire_input_tokens=${estimated}, requested_completion_tokens=${requested}, context_window_tokens=${context ?? 'undeclared'}, max_output_tokens=${output ?? 'undeclared'}, heuristic_deficit=${deficit ?? 'unknown'}, reason=${reason}. Lower compaction.input_budget_tokens or adjust routes/capabilities.`,
    );
    this.name = 'CandidateAdmissionError';
  }
}

function waitUntil(
  untilMs: number,
  now: number,
  deadlineMs: number,
): { kind: 'wait'; waitMs: number } | { kind: 'timeout' } {
  const remainingMs = deadlineMs - now;
  if (remainingMs <= 0) return { kind: 'timeout' };
  return { kind: 'wait', waitMs: Math.min(Math.max(0, untilMs - now), remainingMs) };
}

function updateReadyStates(states: CandidateRecoveryRecord[]): void {
  const now = Date.now();
  for (const state of states) {
    if (state.state === 'RETRY_WAITING_UNTIL' && (state.untilMs ?? 0) <= now)
      state.state = 'RETRYABLE_READY';
    if (state.state === 'RATE_LIMIT_WAITING_UNTIL' && (state.untilMs ?? 0) <= now)
      state.state = 'RATE_LIMIT_READY';
  }
}

function delayWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  if (typeof DOMException !== 'undefined')
    return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortFromSignal(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof Error && error.name === 'AbortError';
}

function indexProviderExchangeAttempts(
  sourceInputId: string,
  offset: number,
  attempts: ProviderExchangeAttempt[],
): ProviderExchangeAttempt[] {
  return attempts.map((attempt, index) => ({
    ...attempt,
    source_input_id: sourceInputId,
    attempt_index: offset + index,
  }));
}
