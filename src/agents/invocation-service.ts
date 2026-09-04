import { createHash } from 'node:crypto';
import { ConversationSessionIdSchema, canonicalJson, type AgentName } from '../schemas/index.js';
import type { FreshnessEffects } from '../application/freshness-effects.js';
import { buildLlmOptions } from './llm-options-factory.js';
import { candidatesEqual, type Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import type { CandidateAvailability } from './candidate-availability.js';
import type { CapabilityRequest } from './provider-capabilities.js';
import { supportsCapabilityRequest, type EffectiveProviderCapabilities } from './provider-capabilities.js';
import { defaultInvocationRecoveryPolicy } from './invocation-recovery-policy.js';
import {
  assertProviderConversationSourceRows,
  ProviderTurnFailure,
  type LlmCompleteOptions,
  type ProviderConversationProjection,
  type ProviderTurnCompletion,
  type ToolDefinition,
} from './llm-contracts.js';
import type { ProviderExchangeAttempt, ProviderExchangePublicationContext } from '../contracts/provider-exchange.js';
import { appendAppLogEntry } from '../persistence/app-log.js';
import { buildCandidateRequest, CandidateRequestPlanIntegrityError, type CandidateRequestPlan } from './candidate-request.js';
import type { InvocationRoutePass, PreparedCompaction } from '../runtime/actors/llm-invocation.js';
import type { PreparedInvocationContext } from '../runtime/actors/context/context-blocks.js';
import { projectProviderExchangeForPublication } from './provider-exchange-projection.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { LlmRequestError } from '../contracts/llm-failure.js';
import { selectLlmProtocolAdapter } from './llm-protocol-adapter.js';
import { executeLlmProviderAttempt } from './llm-provider-attempt.js';
import {
  AdmittedProviderTurnFailure,
  AdmittedRecoveryIntegrityError,
  AdmissionIntegrityError,
  capabilityRequestSha256,
  classifyCandidateLocalAdmission,
  ordinaryAdmittedExecutionAuthority,
  retainedAdmissionStateDiagnostics,
  verifySuspendedAdmittedExecution,
  type AdmittedCandidateAttemptState,
  type AdmittedExecutionBindings,
  type AdmittedRecoveryPreparation,
  type AdmissionSizeLimits,
  type CandidateLocalAdmission,
  type CandidateLocalAdmissionVerdict,
  type OrdinaryAdmittedExecution,
  type OrdinaryAdmittedExecutionAuthority,
  type OrdinaryAdmittedExecutionInputs,
  type OrdinaryPrimaryRequestAdmission,
  type PinnedAdmittedContentPolicyRequest,
  type PinnedContentPolicyPreflight,
  type SuspendedAdmittedExecution,
} from './invocation-admission.js';

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

interface InvocationRequestBase {
  inputId: string;
  agentName: AgentName;
  sessionId: string;
  systemPrompt: string;
  providerConversation: ProviderConversationProjection;
  tools: ToolDefinition[];
  terminalToolNames: string[];
  capabilityRequest: CapabilityRequest;
  abortSignal?: AbortSignal;
  routePass: InvocationRoutePass;
}

export type InvocationRequest = InvocationRequestBase &
  (
    | {
        preparedCompaction: PreparedCompaction;
        preparedContext: PreparedInvocationContext;
        modelParams: { temperature: number; maxTokens?: never };
      }
    | { preparedCompaction?: never; preparedContext?: never; modelParams: { temperature: number; maxTokens: number } }
  );

export interface InvocationServiceConfig {
  projectRoot: string;
  registry: ProviderRegistry;
  candidateAvailability: CandidateAvailability;
  freshness: Pick<FreshnessEffects, 'llmExchangeChanged'>;
}

type MutableAdmittedRecord = { readonly identity: Candidate; readonly routeIndex: number; state: AdmittedCandidateAttemptState };

type AdmittedExecutionRun = {
  authority: OrdinaryAdmittedExecutionAuthority;
  records: MutableAdmittedRecord[];
  plans: Map<number, CandidateRequestPlan>;
  execution: OrdinaryAdmittedExecutionInputs;
  bindings: AdmittedExecutionBindings;
  settled: ProviderExchangeAttempt[];
  deadlineMs: number;
  lastFailure: unknown;
  mandatoryFirst: Candidate | null;
  recoveryMode: boolean;
  signal?: AbortSignal;
};

export class InvocationService {
  private readonly projectRoot: string;
  private readonly candidateAvailability: CandidateAvailability;
  private readonly recoveryDelayMs: number;
  private readonly maxRecoveryRetries: number;
  private readonly registry: ProviderRegistry;
  private readonly freshness: Pick<FreshnessEffects, 'llmExchangeChanged'>;

  constructor(config: InvocationServiceConfig) {
    this.projectRoot = config.projectRoot;
    this.registry = config.registry;
    this.candidateAvailability = config.candidateAvailability;
    this.recoveryDelayMs = INVOCATION_RECOVERY_DELAY_MS;
    this.maxRecoveryRetries = MAX_INVOCATION_RECOVERY_RETRIES;
    this.freshness = config.freshness;
  }

  preparePrimaryRequestAdmission(request: InvocationRequest): OrdinaryPrimaryRequestAdmission {
    if (request.routePass.kind !== 'ordinary') throw new Error('Ordinary primary-request admission requires an ordinary route pass.');
    assertProviderConversationSourceRows(request.providerConversation);
    const chain = [...request.routePass.candidateChain];
    for (const [index, candidate] of chain.entries())
      if (chain.some((other, otherIndex) => otherIndex > index && candidatesEqual(other, candidate)))
        throw new Error(`Ordinary candidate chain contains a duplicate configured identity: ${candidate.provider}/${candidate.account ?? '_implicit'}/${candidate.model}.`);
    const capabilityRequest = Object.freeze({ ...request.capabilityRequest });
    const capabilityHash = capabilityRequestSha256(capabilityRequest);
    const limits = admissionSizeLimits(request);
    const options = this.buildRequestOptions(request);
    const candidates: CandidateLocalAdmission[] = chain.map((candidate) => {
      const capabilities = this.registry.getEffectiveCapabilities(candidate);
      const adapter = selectLlmProtocolAdapter(capabilities.transportProtocol);
      const plan = buildCandidateRequest({
        candidate,
        capabilities,
        adapter,
        systemPrompt: request.systemPrompt,
        providerConversation: request.providerConversation,
        options,
      });
      return admissionVerdict(candidate, capabilityRequest, capabilityHash, capabilities, plan, limits);
    });
    const bindings = executionBindings(request, capabilityRequest, capabilityHash);
    const execution: OrdinaryAdmittedExecutionInputs = Object.freeze({ capabilityRequest, options });
    const admitted = candidates.filter((verdict): verdict is Extract<CandidateLocalAdmission, { kind: 'admitted' }> => verdict.kind === 'admitted');
    if (admitted.length > 0)
      return Object.freeze({
        kind: 'admitted',
        routePass: request.routePass,
        candidates: Object.freeze(candidates),
        executionAuthority: ordinaryAdmittedExecutionAuthority(admitted.map((verdict) => verdict.candidate)),
        bindings,
        execution,
      });
    if (candidates.some((verdict) => verdict.kind === 'projection_too_large'))
      return Object.freeze({ kind: 'local_compaction_required', routePass: request.routePass, candidates: Object.freeze(candidates), bindings });
    return Object.freeze({ kind: 'local_admission_failed', routePass: request.routePass, candidates: Object.freeze(candidates), bindings });
  }

  preflightPinnedContentPolicyRequest(request: InvocationRequest): PinnedContentPolicyPreflight {
    if (request.routePass.kind !== 'pinned-content-policy-retry') throw new Error('Pinned content-policy preflight requires a pinned route pass.');
    assertProviderConversationSourceRows(request.providerConversation);
    const candidate = this.registry.assertCandidate(request.routePass.candidate);
    const capabilityRequest = Object.freeze({ ...request.capabilityRequest });
    const capabilityHash = capabilityRequestSha256(capabilityRequest);
    const limits = admissionSizeLimits(request);
    const options = this.buildRequestOptions(request);
    const capabilities = this.registry.getEffectiveCapabilities(candidate);
    const adapter = selectLlmProtocolAdapter(capabilities.transportProtocol);
    const plan = buildCandidateRequest({
      candidate,
      capabilities,
      adapter,
      systemPrompt: request.systemPrompt,
      providerConversation: request.providerConversation,
      options,
    });
    const verdict = admissionVerdict(candidate, capabilityRequest, capabilityHash, capabilities, plan, limits);
    if (verdict.kind === 'admitted')
      return Object.freeze({ kind: 'admitted', plan, candidate, capabilityRequest, inputId: request.inputId, options });
    return Object.freeze({ kind: 'rejected', candidate, verdict });
  }

  async executeAdmittedWithRecovery(admission: OrdinaryAdmittedExecution, signal?: AbortSignal): Promise<ProviderTurnCompletion> {
    if (admission.kind !== 'admitted') throw new AdmissionIntegrityError('Ordinary admitted execution requires an admitted admission object.');
    const records: MutableAdmittedRecord[] = [];
    const plans = new Map<number, CandidateRequestPlan>();
    for (const [routeIndex, verdict] of admission.candidates.entries()) {
      if (verdict.kind !== 'admitted') continue;
      records.push({ identity: verdict.candidate, routeIndex, state: { kind: 'untried', attempts: 0 } });
      plans.set(routeIndex, verdict.plan);
    }
    if (records.length !== admission.executionAuthority.admittedCandidateIdentities.length)
      throw new AdmissionIntegrityError('Ordinary admitted records do not match the frozen execution authority membership.');
    return this.runAdmittedExecution({
      authority: admission.executionAuthority,
      records,
      plans,
      execution: admission.execution,
      bindings: admission.bindings,
      settled: [],
      deadlineMs: Date.now() + LLM_UNAVAILABILITY_TIMEOUT_MS,
      lastFailure: null,
      mandatoryFirst: null,
      recoveryMode: false,
      signal,
    });
  }

  prepareAdmittedRecovery(args: { suspension: SuspendedAdmittedExecution; request: InvocationRequest }): AdmittedRecoveryPreparation {
    const { suspension, request } = args;
    if (request.routePass.kind !== 'ordinary') throw new AdmittedRecoveryIntegrityError('Admitted recovery preparation requires an ordinary route pass.');
    assertProviderConversationSourceRows(request.providerConversation);
    verifySuspendedAdmittedExecution(suspension);
    const capabilityRequest = Object.freeze({ ...request.capabilityRequest });
    const capabilityHash = capabilityRequestSha256(capabilityRequest);
    const bindings = executionBindings(request, capabilityRequest, capabilityHash);
    assertBindingsUnchanged(suspension.bindings, bindings);
    const limits = admissionSizeLimits(request);
    const options = this.buildRequestOptions(request);
    const plans: { routeIndex: number; plan: CandidateRequestPlan }[] = [];
    for (const record of suspension.records) {
      if (record.state.kind === 'exhausted') continue;
      const capabilities = this.registry.getEffectiveCapabilities(record.identity);
      const adapter = selectLlmProtocolAdapter(capabilities.transportProtocol);
      const plan = buildCandidateRequest({
        candidate: record.identity,
        capabilities,
        adapter,
        systemPrompt: request.systemPrompt,
        providerConversation: request.providerConversation,
        options,
      });
      const verdict = admissionVerdict(record.identity, capabilityRequest, capabilityHash, capabilities, plan, limits);
      if (record.state.kind === 'context_failed') {
        if (verdict.kind !== 'admitted')
          throw new ProviderTurnFailure({
            failure_phase: 'provider_attempt',
            provider_exchanges: [...suspension.settledProviderAttempts],
            originalFailure: recoveryTerminalFailure(suspension, `the mandatory context-failed candidate did not re-admit for the compacted projection (verdict=${verdict.kind})`),
            candidate: record.identity,
          });
        plans.push({ routeIndex: record.routeIndex, plan });
        continue;
      }
      if (verdict.kind !== 'admitted')
        throw new AdmittedRecoveryIntegrityError(`Retained admitted candidate at route index ${record.routeIndex} no longer admits against the strictly smaller compacted projection.`);
      plans.push({ routeIndex: record.routeIndex, plan });
    }
    return Object.freeze({
      kind: 'recovery_prepared',
      authority: suspension.authority,
      bindings,
      records: suspension.records.map((record) => Object.freeze({ identity: record.identity, routeIndex: record.routeIndex, state: Object.freeze({ ...record.state }) })),
      plans: Object.freeze(plans),
      mandatoryFirstIdentity: suspension.contextFailedIdentity,
      settledProviderAttempts: suspension.settledProviderAttempts,
      deadlineMs: suspension.deadlineMs,
      execution: Object.freeze({ capabilityRequest, options }),
    });
  }

  async resumeAdmittedExecution(preparation: AdmittedRecoveryPreparation, signal?: AbortSignal): Promise<ProviderTurnCompletion> {
    if (preparation.kind !== 'recovery_prepared') throw new AdmittedRecoveryIntegrityError('Admitted recovery resume requires a recovery preparation object.');
    const records: MutableAdmittedRecord[] = preparation.records.map((record) => ({ identity: record.identity, routeIndex: record.routeIndex, state: record.state }));
    const plans = new Map(preparation.plans.map((entry) => [entry.routeIndex, entry.plan]));
    return this.runAdmittedExecution({
      authority: preparation.authority,
      records,
      plans,
      execution: preparation.execution,
      bindings: preparation.bindings,
      settled: [...preparation.settledProviderAttempts],
      deadlineMs: preparation.deadlineMs,
      lastFailure: null,
      mandatoryFirst: preparation.mandatoryFirstIdentity,
      recoveryMode: true,
      signal,
    });
  }

  async executePinnedContentPolicyRequest(preflight: PinnedAdmittedContentPolicyRequest, signal?: AbortSignal): Promise<ProviderTurnCompletion> {
    const candidate = preflight.candidate;
    try {
      throwIfAborted(signal);
      const completion = await this.executeAdmittedPlan(preflight.plan, { ...preflight.options, signal }, preflight.capabilityRequest);
      const attempts = indexProviderExchangeAttempts(preflight.inputId, 0, completion.provider_exchanges);
      try {
        throwIfAborted(signal);
      } catch (error) {
        throw new ProviderTurnFailure({
          failure_phase: 'provider_attempt',
          provider_exchanges: attempts,
          originalFailure: error,
          candidate,
        });
      }
      return { ...completion, provider_exchanges: attempts };
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if (error instanceof ProviderTurnFailure) {
        const attempts = error.failure_phase === 'provider_attempt' ? indexProviderExchangeAttempts(preflight.inputId, 0, error.provider_exchanges) : [];
        throw new ProviderTurnFailure({
          failure_phase: attempts.length > 0 ? 'provider_attempt' : 'pre_provider',
          provider_exchanges: attempts,
          originalFailure: error.originalFailure,
          candidate,
        });
      }
      throw new ProviderTurnFailure({
        failure_phase: 'pre_provider',
        provider_exchanges: [],
        originalFailure: error,
        candidate,
      });
    }
  }

  projectProviderExchanges(
    sessionId: string,
    sourceInputId: string,
    attempts: ProviderExchangeAttempt[],
    context: ProviderExchangePublicationContext,
  ): void {
    const hasOk = attempts.some((attempt) => attempt.status === 'ok');
    if (context.terminalConversationOutputId !== null && hasOk) throw new Error('A terminal conversation output id cannot be published with a successful provider attempt.');
    if (context.assistantOutputIds.length > 0 && !hasOk) throw new Error('Assistant output ids require a successful provider attempt.');
    const parsedSessionId = ConversationSessionIdSchema.safeParse(sessionId);
    for (const attempt of attempts) {
      appendAppLogEntry(this.projectRoot, 'provider_exchange', () => {
        if (attempt.attempt_index === undefined)
          throw new Error(`Provider exchange for '${sourceInputId}' is missing attempt_index.`);
        if (attempt.source_input_id !== sourceInputId)
          throw new Error(
            `Provider exchange source_input_id '${attempt.source_input_id}' does not match '${sourceInputId}'.`,
          );
        const payload = projectProviderExchangeForPublication(
          attempt as ProviderExchangeAttempt & { attempt_index: number },
          attempt.status === 'ok'
            ? { assistantOutputIds: context.assistantOutputIds, terminalConversationOutputId: null }
            : { assistantOutputIds: [], terminalConversationOutputId: hasOk ? null : context.terminalConversationOutputId },
        );
        return {
          type: 'provider_exchange',
          data: {
            session_id: sessionId,
            source_input_id: sourceInputId,
            attempt_index: attempt.attempt_index,
            timestamp: attempt.completed_at,
            payload,
          },
        };
      });
      if (parsedSessionId.success) this.freshness.llmExchangeChanged(parsedSessionId.data);
    }
  }

  protected async executeAdmittedPlan(
    plan: CandidateRequestPlan,
    options: LlmCompleteOptions,
    capabilityRequest: Readonly<CapabilityRequest>,
  ): Promise<ProviderTurnCompletion> {
    return executeLlmProviderAttempt({
      projectRoot: this.projectRoot,
      registry: this.registry,
      plan,
      options,
      capabilityRequest,
    });
  }

  private buildRequestOptions(request: InvocationRequest): LlmCompleteOptions {
    const outputTokens = requestedCompletionTokensOf(request);
    return buildLlmOptions(
      request.agentName,
      request.tools,
      request.terminalToolNames,
      { temperature: request.modelParams.temperature, max_tokens: outputTokens },
      undefined,
      request.inputId,
    );
  }

  private async runAdmittedExecution(run: AdmittedExecutionRun): Promise<ProviderTurnCompletion> {
    const { signal } = run;
    for (;;) {
      throwIfAborted(signal);
      this.refreshRecordStates(run.records);
      let record: MutableAdmittedRecord;
      if (run.mandatoryFirst) {
        const mandatory = run.records.find((entry) => candidatesEqual(entry.identity, run.mandatoryFirst!));
        if (!mandatory) throw new AdmittedRecoveryIntegrityError('The mandatory context-failed candidate is not part of the retained admission records.');
        run.mandatoryFirst = null;
        record = mandatory;
      } else {
        const next = this.nextCandidateState(run.records, run.deadlineMs);
        if (next.kind === 'timeout') {
          const message = `No LLM candidate became available for agent '${run.bindings.agentName}' within ${LLM_UNAVAILABILITY_TIMEOUT_MS}ms.`;
          throw new ProviderTurnFailure({
            failure_phase: run.settled.length > 0 ? 'provider_attempt' : 'pre_provider',
            provider_exchanges: run.settled,
            originalFailure: run.lastFailure ?? new Error(message),
            message,
            candidate: null,
          });
        }
        if (next.kind === 'wait') {
          await delayWithAbort(next.waitMs, signal);
          continue;
        }
        if (next.kind === 'none') {
          const originalFailure =
            run.lastFailure ??
            new Error(`No healthy candidates available for agent '${run.bindings.agentName}'.`);
          throw new ProviderTurnFailure({
            failure_phase: run.settled.length > 0 ? 'provider_attempt' : 'pre_provider',
            provider_exchanges: run.settled,
            originalFailure,
            candidate: null,
          });
        }
        record = next.record;
        if (!this.candidateAvailability.isAvailable(record.identity)) {
          const entry = this.candidateAvailability.getEntry(record.identity);
          const attempts = attemptsOf(record.state);
          if (entry && entry.state !== 'HEALTHY' && entry.reason && WAITABLE_UNAVAILABILITY_REASONS.has(entry.reason)) {
            record.state = { kind: 'temporarily_unavailable', attempts, untilMs: entry.untilMs, reason: entry.reason };
          } else {
            record.state = { kind: 'exhausted', attempts, lastFailure: lastFailureOf(record.state) };
          }
          continue;
        }
      }
      const plan = run.plans.get(record.routeIndex);
      if (!plan) throw new AdmittedRecoveryIntegrityError(`No admitted plan is retained for route index ${record.routeIndex}.`);
      try {
        const result = await this.executeAdmittedPlan(plan, { ...run.execution.options, signal }, run.execution.capabilityRequest);
        run.settled.push(
          ...indexProviderExchangeAttempts(
            run.bindings.inputId,
            run.settled.length,
            result.provider_exchanges,
          ),
        );
        throwIfAborted(signal);
        this.candidateAvailability.markSucceeded(record.identity);
        return {
          result: result.result,
          provider_exchanges: run.settled,
          provider_private_context: result.provider_private_context,
        };
      } catch (err) {
        const outcome = this.handleAdmittedAttemptFailure(run, record, err);
        if (outcome !== null) throw outcome;
      }
    }
  }

  private handleAdmittedAttemptFailure(run: AdmittedExecutionRun, record: MutableAdmittedRecord, err: unknown): unknown {
    const signal = run.signal;
    throwIfPublicationOutcomeUnknown(err);
    if (err instanceof CandidateRequestPlanIntegrityError || err instanceof AdmissionIntegrityError) return err;
    if (isAbortFromSignal(err, signal)) return err;
    const originalFailure = err instanceof ProviderTurnFailure ? err.originalFailure : err;
    if (isAbortFromSignal(originalFailure, signal)) return originalFailure;
    const attempts = attemptsOf(record.state) + 1;
    const decision = defaultInvocationRecoveryPolicy.decideFailure(originalFailure, {
      candidate: record.identity,
      recoveryDelayMs: this.recoveryDelayMs,
    });
    if (err instanceof ProviderTurnFailure && err.failure_phase === 'provider_attempt') {
      if (err.provider_exchanges.length === 0)
        return new Error(
          `Provider attempt for input '${run.bindings.inputId}' settled without a provider_exchange envelope.`,
        );
      run.settled.push(
        ...indexProviderExchangeAttempts(
          run.bindings.inputId,
          run.settled.length,
          err.provider_exchanges,
        ),
      );
    }
    if (decision.availability) {
      throwIfAborted(signal);
      this.candidateAvailability.markFailed(record.identity, decision.availability);
    }
    const contextExhausted =
      err instanceof ProviderTurnFailure &&
      err.failure_phase === 'provider_attempt' &&
      originalFailure instanceof LlmRequestError &&
      originalFailure.failure.kind === 'input_context_exhausted';
    if (contextExhausted && !run.recoveryMode) {
      record.state = Object.freeze({ kind: 'context_failed', attempts, failure: err });
      const turnFailure = new ProviderTurnFailure({
        failure_phase: 'provider_attempt',
        provider_exchanges: run.settled,
        originalFailure,
        candidate: record.identity,
      });
      return new AdmittedProviderTurnFailure(
        turnFailure,
        Object.freeze({
          authority: run.authority,
          records: Object.freeze(run.records.map((entry) => Object.freeze({ identity: entry.identity, routeIndex: entry.routeIndex, state: Object.freeze({ ...entry.state }) }))),
          contextFailedIdentity: record.identity,
          settledProviderAttempts: Object.freeze([...run.settled]),
          deadlineMs: run.deadlineMs,
          bindings: run.bindings,
        }),
      );
    }
    if (decision.kind === 'terminal') {
      if (contextExhausted && run.recoveryMode) {
        const failure = originalFailure as LlmRequestError;
        return new ProviderTurnFailure({
          failure_phase: 'provider_attempt',
          provider_exchanges: run.settled,
          originalFailure: new LlmRequestError({
            ...failure.failure,
            message: 'Provider input context remained exhausted after one forced compacted retry.',
          }),
          candidate: record.identity,
        });
      }
      return new ProviderTurnFailure({
        failure_phase: run.settled.length > 0 ? 'provider_attempt' : 'pre_provider',
        provider_exchanges: run.settled,
        originalFailure,
        candidate: record.identity,
      });
    }
    run.lastFailure = originalFailure;
    const hasBudget = attempts < 1 + this.maxRecoveryRetries;
    if (!hasBudget) {
      record.state = { kind: 'exhausted', attempts, lastFailure: originalFailure };
      return null;
    }
    if (decision.wait === 'rate-limit') {
      record.state = { kind: 'retry_waiting', wait: 'rate_limit', attempts, untilMs: decision.availability.untilMs, lastFailure: originalFailure };
    } else {
      record.state = { kind: 'retry_waiting', wait: 'standard', attempts, untilMs: Date.now() + decision.retryDelayMs, lastFailure: originalFailure };
    }
    return null;
  }

  private nextCandidateState(
    records: MutableAdmittedRecord[],
    deadlineMs: number,
  ):
    | { kind: 'attempt'; record: MutableAdmittedRecord }
    | { kind: 'wait'; waitMs: number }
    | { kind: 'timeout' }
    | { kind: 'none' } {
    const now = Date.now();
    const standardWaiting = records.find((record) => record.state.kind === 'retry_waiting' && record.state.wait === 'standard');
    if (standardWaiting && standardWaiting.state.kind === 'retry_waiting') return waitUntil(standardWaiting.state.untilMs, now, deadlineMs);
    const standardReady = records.find((record) => record.state.kind === 'retry_ready' && record.state.wait === 'standard');
    if (standardReady) return { kind: 'attempt', record: standardReady };
    const untried = records.find(
      (record) => record.state.kind === 'untried' && this.candidateAvailability.isAvailable(record.identity),
    );
    if (untried) return { kind: 'attempt', record: untried };
    const rateReady = records.find((record) => record.state.kind === 'retry_ready' && record.state.wait === 'rate_limit');
    if (rateReady) return { kind: 'attempt', record: rateReady };
    const rateWaiting = records
      .map((record) => (record.state.kind === 'retry_waiting' && record.state.wait === 'rate_limit' ? record.state.untilMs : undefined))
      .filter((untilMs): untilMs is number => untilMs !== undefined)
      .sort((a, b) => a - b)[0];
    if (rateWaiting !== undefined) return waitUntil(rateWaiting, now, deadlineMs);
    for (const record of records) {
      if (record.state.kind === 'exhausted') continue;
      const entry = this.candidateAvailability.getEntry(record.identity);
      if (!entry || entry.state === 'HEALTHY') continue;
      if (entry.reason && WAITABLE_UNAVAILABILITY_REASONS.has(entry.reason))
        return waitUntil(entry.untilMs, now, deadlineMs);
    }
    return { kind: 'none' };
  }

  private refreshRecordStates(records: MutableAdmittedRecord[]): void {
    const now = Date.now();
    for (const record of records) {
      const state = record.state;
      if (state.kind === 'retry_waiting' && state.untilMs <= now)
        record.state = { kind: 'retry_ready', wait: state.wait, attempts: state.attempts, lastFailure: state.lastFailure };
      else if (state.kind === 'temporarily_unavailable') {
        const entry = this.candidateAvailability.getEntry(record.identity);
        if (!entry || entry.state === 'HEALTHY' || now >= entry.untilMs)
          record.state = { kind: 'retry_ready', wait: 'standard', attempts: state.attempts, lastFailure: undefined };
        else record.state = { kind: 'temporarily_unavailable', attempts: state.attempts, untilMs: entry.untilMs, reason: entry.reason };
      }
    }
  }
}

function attemptsOf(state: AdmittedCandidateAttemptState): number {
  return state.attempts;
}

function lastFailureOf(state: AdmittedCandidateAttemptState): unknown {
  if (state.kind === 'retry_waiting' || state.kind === 'retry_ready' || state.kind === 'exhausted') return state.lastFailure;
  return null;
}

function requestedCompletionTokensOf(request: InvocationRequest): number {
  return request.preparedCompaction !== undefined
    ? request.preparedCompaction.requestedCompletionTokens
    : request.modelParams.maxTokens;
}

function admissionSizeLimits(request: InvocationRequest): AdmissionSizeLimits {
  const requestedCompletionTokens = requestedCompletionTokensOf(request);
  if (request.preparedCompaction && requestedCompletionTokens > request.preparedCompaction.reservedCompletionTokens)
    throw new Error('Prepared completion request exceeds the prepared compaction output reserve.');
  return {
    inputBudgetTokens: request.preparedCompaction?.inputBudgetTokens ?? null,
    requestedCompletionTokens,
    reservedCompletionTokens: request.preparedCompaction?.reservedCompletionTokens ?? null,
  };
}

function admissionVerdict(
  candidate: Candidate,
  capabilityRequest: Readonly<CapabilityRequest>,
  capabilityHash: string,
  capabilities: EffectiveProviderCapabilities,
  plan: CandidateRequestPlan,
  limits: AdmissionSizeLimits,
): CandidateLocalAdmission {
  const match = supportsCapabilityRequest(capabilities, capabilityRequest);
  const verdict: CandidateLocalAdmissionVerdict = classifyCandidateLocalAdmission({ capabilities, match, plan, limits });
  return Object.freeze({ candidate, capabilityRequest, capabilityRequestSha256: capabilityHash, ...verdict });
}

function executionBindings(request: InvocationRequest, capabilityRequest: Readonly<CapabilityRequest>, capabilityHash: string): AdmittedExecutionBindings {
  const requestedCompletionTokens = requestedCompletionTokensOf(request);
  return Object.freeze({
    inputId: request.inputId,
    sessionId: request.sessionId,
    agentName: request.agentName,
    sourceSessionId: request.providerConversation.sourceSessionId,
    systemPromptSha256: sha256Of(request.systemPrompt),
    toolsSha256: sha256Of(canonicalJson(request.tools)),
    terminalToolNamesSha256: sha256Of(canonicalJson(request.terminalToolNames)),
    capabilityRequest,
    capabilityRequestSha256: capabilityHash,
    temperature: request.modelParams.temperature,
    requestedCompletionTokens,
    inputBudgetTokens: request.preparedCompaction?.inputBudgetTokens ?? null,
    preparedCompactionSha256: sha256Of(canonicalJson(request.preparedCompaction ?? null)),
  });
}

function assertBindingsUnchanged(expected: AdmittedExecutionBindings, actual: AdmittedExecutionBindings): void {
  const fields: readonly (keyof AdmittedExecutionBindings)[] = [
    'inputId',
    'sessionId',
    'agentName',
    'sourceSessionId',
    'systemPromptSha256',
    'toolsSha256',
    'terminalToolNamesSha256',
    'capabilityRequestSha256',
    'temperature',
    'requestedCompletionTokens',
    'inputBudgetTokens',
    'preparedCompactionSha256',
  ];
  for (const field of fields) {
    const left = expected[field];
    const right = actual[field];
    if (left !== right)
      throw new AdmittedRecoveryIntegrityError(`Suspended admitted execution binding '${field}' changed across authoritative compaction ('${String(left)}' != '${String(right)}').`);
  }
}

function recoveryTerminalFailure(suspension: SuspendedAdmittedExecution, detail: string): LlmRequestError {
  const contextRecord = suspension.records.find((record) => record.state.kind === 'context_failed');
  if (!contextRecord || contextRecord.state.kind !== 'context_failed') throw new AdmittedRecoveryIntegrityError('Suspended admitted execution lost its context-failed record.');
  const original = contextRecord.state.failure.originalFailure;
  const diagnostics = JSON.stringify(retainedAdmissionStateDiagnostics(suspension));
  if (original instanceof LlmRequestError)
    return new LlmRequestError({
      ...original.failure,
      message: `Provider input context exhausted; ordinary authoritative recovery terminated because ${detail}. ${diagnostics}`,
    });
  return new LlmRequestError({ kind: 'input_context_exhausted', provider: 'unknown', status: 0, message: `Provider input context exhausted; ordinary authoritative recovery terminated because ${detail}.` });
}

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
