import { createHash } from 'node:crypto';

import { ConversationSessionIdSchema, canonicalJson, type AgentName } from '../schemas/index.js';
import type { FreshnessEffects } from '../application/freshness-effects.js';
import { buildLlmOptions } from './llm-options-factory.js';
import { candidatesEqual, type Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';
import type { CandidateAvailability } from './candidate-availability.js';
import {
  supportsCapabilityRequest,
  type CapabilityRequest,
  type CapabilitySkipReason,
} from './provider-capabilities.js';
import { defaultInvocationRecoveryPolicy } from './invocation-recovery-policy.js';
import {
  assertProviderConversationSourceRows,
  ProviderTurnFailure,
  type LlmCompleteOptions,
  type ProviderConversationProjection,
  type ProviderTurnCompletion,
} from './llm-contracts.js';
import type { ProviderExchangeAttempt, ProviderExchangePublicationContext } from '../contracts/provider-exchange.js';
import { appendAppLogEntry } from '../persistence/app-log.js';
import { buildCandidateRequest, CandidateRequestPlanIntegrityError, type CandidateRequestPlan } from './candidate-request.js';
import type {
  CompiledInvocationToolContract,
  InvocationRoutePass,
  PreparedCompaction,
  StaticInvocationPrefix,
} from '../runtime/actors/llm-invocation.js';
import type { ContextBlock } from '../runtime/actors/context/index.js';
import { projectProviderExchangeForPublication } from './provider-exchange-projection.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { selectLlmProtocolAdapter } from './llm-protocol-adapter.js';
import { CandidateAdmissionIntegrityError, executeLlmProviderAttempt } from './llm-provider-attempt.js';
import { unwrapFailure } from '../contracts/llm-failure.js';

const INVOCATION_RECOVERY_DELAY_MS = 60_000;
const MAX_INVOCATION_RECOVERY_RETRIES = 3;
const LLM_UNAVAILABILITY_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const WAITABLE_UNAVAILABILITY_REASONS = new Set(['server_transient', 'timeout', 'rate_limit', 'unknown', 'parse_error']);
const DIAGNOSTIC_CANDIDATE_LIMIT = 32;
const DIAGNOSTIC_PREVIEW_BYTES = 128;

export type CandidateIdentity = Readonly<{ provider: string; account: string | null; model: string }>;

export type CandidateLocalAdmission = Readonly<{
  candidate: CandidateIdentity;
  capabilityRequest: Readonly<CapabilityRequest>;
  capabilityRequestSha256: string;
}> & (
  | Readonly<{ kind: 'admitted'; plan: CandidateRequestPlan }>
  | Readonly<{
      kind: 'projection_too_large';
      protocol: string;
      requestHash: string;
      serializedBytes: number;
      estimatedInputTokens: number;
      requestedCompletionTokens: number;
      inputBudgetTokens: number;
      contextWindowTokens: number;
    }>
  | Readonly<{
      kind: 'candidate_ineligible';
      reason:
        | Readonly<{ kind: 'capability_mismatch'; reasons: readonly CapabilitySkipReason[] }>
        | Readonly<{ kind: 'missing_context_window' }>
        | Readonly<{ kind: 'missing_max_output' }>
        | Readonly<{ kind: 'max_output_too_small' }>;
    }>
);

export type OrdinaryAdmittedExecutionAuthority = Readonly<{
  kind: 'ordinary';
  admittedCandidateIdentities: readonly CandidateIdentity[];
  admittedCandidateIdentitiesSha256: string;
}>;

export type AdmissionDiagnostic = Readonly<{
  verdictSha256: string;
  totalCandidates: number;
  omittedCandidateCount: number;
  counts: Readonly<Record<string, number>>;
  candidates: readonly Readonly<{
    routeIndex: number;
    candidateIdentitySha256: string;
    providerPreview: string;
    modelPreview: string;
    accountPresent: boolean;
    verdict: string;
    capabilityReasons?: readonly CapabilitySkipReason[];
  }>[];
}>;

export class LocalExactAdmissionError extends Error {
  constructor(
    readonly diagnostic: AdmissionDiagnostic,
    readonly localCompactionAttempted: boolean,
    message = 'No provider candidate admitted the exact primary request.',
  ) {
    super(message);
    this.name = 'LocalExactAdmissionError';
  }
}

export class PinnedContentPolicyPreflightError extends Error {
  constructor(
    readonly diagnostic: AdmissionDiagnostic,
    readonly providerExchanges: readonly ProviderExchangeAttempt[] = [],
    readonly candidate: CandidateIdentity | null = null,
  ) {
    super('The refusing provider candidate did not admit the exact pinned content-policy request.');
    this.name = 'PinnedContentPolicyPreflightError';
  }
}

interface InvocationRequestBase {
  inputId: string;
  agentName: AgentName;
  sessionId: string;
  prefix: StaticInvocationPrefix;
  providerConversation: ProviderConversationProjection;
  compiledTools: readonly CompiledInvocationToolContract[];
  internalToolContractSha256: string;
  dynamicBlocks: readonly ContextBlock[];
  dynamicBlocksSha256: string;
  capabilityRequest: CapabilityRequest;
  abortSignal?: AbortSignal;
  routePass: InvocationRoutePass;
}

export type InvocationRequest = InvocationRequestBase & (
  | { preparedCompaction: PreparedCompaction; modelParams: { temperature: number; maxTokens?: never } }
  | { preparedCompaction?: never; modelParams: { temperature: number; maxTokens: number } }
);

type PreparedPrimaryRequest = InvocationRequest & { preparedCompaction: PreparedCompaction; routePass: Extract<InvocationRoutePass, { kind: 'ordinary' }> };

export class OrdinaryPrimaryAdmission {
  readonly kind = 'admitted' as const;
  readonly routePass: PreparedPrimaryRequest['routePass'];
  readonly request: PreparedPrimaryRequest;
  readonly candidates: readonly CandidateLocalAdmission[];
  readonly executionAuthority: OrdinaryAdmittedExecutionAuthority;
  readonly diagnostic: AdmissionDiagnostic;
  readonly plans: readonly CandidateRequestPlan[];
  readonly bindingSha256: string;
  constructor(args: {
    request: PreparedPrimaryRequest;
    candidates: readonly CandidateLocalAdmission[];
    executionAuthority: OrdinaryAdmittedExecutionAuthority;
    diagnostic: AdmissionDiagnostic;
  }) {
    this.request = args.request;
    this.routePass = args.request.routePass;
    this.candidates = Object.freeze([...args.candidates]);
    this.executionAuthority = args.executionAuthority;
    this.diagnostic = args.diagnostic;
    this.plans = Object.freeze(args.candidates.filter((value): value is Extract<CandidateLocalAdmission, { kind: 'admitted' }> => value.kind === 'admitted').map((value) => value.plan));
    this.bindingSha256 = requestBindingSha256(args.request, args.executionAuthority);
    Object.freeze(this);
  }
}

export type OrdinaryPrimaryRequestAdmission =
  | OrdinaryPrimaryAdmission
  | Readonly<{ kind: 'local_compaction_required'; routePass: PreparedPrimaryRequest['routePass']; candidates: readonly CandidateLocalAdmission[]; diagnostic: AdmissionDiagnostic }>
  | Readonly<{ kind: 'local_admission_failed'; routePass: PreparedPrimaryRequest['routePass']; candidates: readonly CandidateLocalAdmission[]; diagnostic: AdmissionDiagnostic }>;

class PinnedContentPolicyAdmission {
  readonly kind = 'admitted' as const;
  readonly candidate: CandidateIdentity;
  readonly plan: CandidateRequestPlan;
  readonly request: InvocationRequest;
  readonly bindingSha256: string;
  readonly #owner: object;
  constructor(owner: object, request: InvocationRequest, plan: CandidateRequestPlan) {
    this.#owner = owner;
    this.request = request;
    this.plan = plan;
    this.candidate = identity(plan.candidate);
    this.bindingSha256 = pinnedBindingSha256(request, plan);
    Object.freeze(this);
  }
  belongsTo(owner: object): boolean { return this.#owner === owner; }
}

export type PinnedContentPolicyPreflight =
  | PinnedContentPolicyAdmission
  | Readonly<{ kind: 'rejected'; candidate: CandidateIdentity; verdict: Exclude<CandidateLocalAdmission, { kind: 'admitted' }>; diagnostic: AdmissionDiagnostic }>;

export type AdmittedCandidateAttemptState =
  | Readonly<{ kind: 'untried'; attempts: 0 }>
  | Readonly<{ kind: 'temporarily_unavailable'; attempts: number; untilMs: number; reason: string | undefined }>
  | Readonly<{ kind: 'retry_waiting'; wait: 'standard' | 'rate_limit'; attempts: number; untilMs: number; lastFailure: unknown }>
  | Readonly<{ kind: 'retry_ready'; wait: 'standard' | 'rate_limit'; attempts: number; lastFailure: unknown }>
  | Readonly<{ kind: 'context_failed'; attempts: number; failure: ProviderTurnFailure }>
  | Readonly<{ kind: 'exhausted'; attempts: number; lastFailure: unknown | null }>;

type MutableExecutionRecord = {
  readonly identity: CandidateIdentity;
  readonly routeIndex: number;
  readonly candidate: Candidate;
  state: AdmittedCandidateAttemptState;
  plan: CandidateRequestPlan;
};

type LiveExecutionState = {
  readonly admission: OrdinaryPrimaryAdmission;
  readonly records: MutableExecutionRecord[];
  readonly options: LlmCompleteOptions;
  readonly deadlineMs: number;
  readonly settledProviderAttempts: ProviderExchangeAttempt[];
  lastFailure: unknown;
  resumed: boolean;
  authoritativeCompactionSpent: boolean;
};

export class SuspendedAdmittedExecution {
  readonly authority: OrdinaryAdmittedExecutionAuthority;
  readonly contextFailedIdentity: CandidateIdentity;
  readonly diagnostic: Readonly<{ candidateScope: 'retained_original_admission_state'; admittedCount: number; admittedHash: string; contextFailedIdentitySha256: string; stateCounts: Readonly<Record<string, number>>; omittedCandidateCount: number; candidates: readonly Readonly<{ routeIndex: number; candidateIdentitySha256: string; providerPreview: string; modelPreview: string; accountPresent: boolean; state: string }>[] }>;
  readonly #owner: object;
  readonly #state: LiveExecutionState;
  constructor(owner: object, state: LiveExecutionState, contextFailedIdentity: CandidateIdentity) {
    this.#owner = owner;
    this.#state = state;
    this.authority = state.admission.executionAuthority;
    this.contextFailedIdentity = contextFailedIdentity;
    this.diagnostic = recoveryDiagnostic(state, contextFailedIdentity);
    Object.freeze(this);
  }
  take(owner: object): LiveExecutionState {
    if (owner !== this.#owner) throw new Error('Suspended admitted execution belongs to another InvocationService.');
    if (this.#state.resumed) throw new Error('Suspended admitted execution has already been resumed.');
    validateSuspendedState(this.#state, this.contextFailedIdentity);
    this.#state.resumed = true;
    return this.#state;
  }
}

export class AdmittedProviderTurnFailure extends Error {
  constructor(readonly failure: ProviderTurnFailure, readonly suspension: SuspendedAdmittedExecution) {
    super(failure.message, { cause: failure });
    this.name = 'AdmittedProviderTurnFailure';
  }
}

export interface InvocationServiceConfig {
  projectRoot: string;
  registry: ProviderRegistry;
  candidateAvailability: CandidateAvailability;
  freshness: Pick<FreshnessEffects, 'llmExchangeChanged'>;
}

export class InvocationService {
  readonly #owner = Object.freeze({});
  private readonly projectRoot: string;
  private readonly candidateAvailability: CandidateAvailability;
  private readonly recoveryDelayMs = INVOCATION_RECOVERY_DELAY_MS;
  private readonly maxRecoveryRetries = MAX_INVOCATION_RECOVERY_RETRIES;
  private readonly registry: ProviderRegistry;
  private readonly freshness: Pick<FreshnessEffects, 'llmExchangeChanged'>;

  constructor(config: InvocationServiceConfig) {
    this.projectRoot = config.projectRoot;
    this.registry = config.registry;
    this.candidateAvailability = config.candidateAvailability;
    this.freshness = config.freshness;
  }

  preparePrimaryRequestAdmission(request: InvocationRequest): OrdinaryPrimaryRequestAdmission {
    if (!request.preparedCompaction) throw new Error('Ordinary primary admission requires prepared compaction.');
    if (request.routePass.kind !== 'ordinary') throw new Error('Ordinary primary admission cannot prepare a pinned route.');
    assertProviderConversationSourceRows(request.providerConversation);
    assertUniqueCandidates(request.routePass.candidateChain);
    const prepared = request as PreparedPrimaryRequest;
    const candidates = Object.freeze(request.routePass.candidateChain.map((candidate) => this.classifyCandidate(prepared, candidate)));
    if (candidates.some((candidate) => candidate.capabilityRequestSha256 !== candidates[0]?.capabilityRequestSha256 || canonicalJson(candidate.capabilityRequest) !== canonicalJson(candidates[0]?.capabilityRequest)))
      throw new Error('Ordinary candidate verdicts disagree on the immutable capability request.');
    const diagnostic = admissionDiagnostic(candidates);
    const admitted = candidates.filter((value): value is Extract<CandidateLocalAdmission, { kind: 'admitted' }> => value.kind === 'admitted');
    if (admitted.length > 0) {
      const identities = Object.freeze(admitted.map((value) => identity(value.candidate)));
      const executionAuthority = Object.freeze({ kind: 'ordinary' as const, admittedCandidateIdentities: identities, admittedCandidateIdentitiesSha256: sha256(canonicalJson(identities)) });
      return new OrdinaryPrimaryAdmission({ request: prepared, candidates, executionAuthority, diagnostic });
    }
    if (candidates.some((value) => value.kind === 'projection_too_large'))
      return Object.freeze({ kind: 'local_compaction_required', routePass: prepared.routePass, candidates, diagnostic });
    return Object.freeze({ kind: 'local_admission_failed', routePass: prepared.routePass, candidates, diagnostic });
  }

  async executeAdmittedWithRecovery(admission: OrdinaryPrimaryAdmission): Promise<ProviderTurnCompletion> {
    this.assertAdmission(admission);
    const state = this.createExecutionState(admission);
    return this.runScheduler(state, null);
  }

  async resumeSuspendedAfterCompaction(
    suspension: SuspendedAdmittedExecution,
    compactedRequest: InvocationRequest,
  ): Promise<ProviderTurnCompletion> {
    const state = suspension.take(this.#owner);
    assertRecoveryRequestBindings(state.admission.request, compactedRequest, state.admission.executionAuthority);
    const contextRecord = state.records.find((record) => sameIdentity(record.identity, suspension.contextFailedIdentity));
    if (!contextRecord || contextRecord.state.kind !== 'context_failed') throw new Error('Suspended execution lost its context-failed candidate.');
    for (const record of state.records) {
      if (record.state.kind === 'exhausted') continue;
      const verdict = this.classifyCandidate(compactedRequest as PreparedPrimaryRequest, record.candidate);
      if (verdict.kind === 'admitted') record.plan = verdict.plan;
      else if (record === contextRecord) {
        const failure = contextRecord.state.failure;
        throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: state.settledProviderAttempts, originalFailure: failure.originalFailure, message: `Context-failed retained candidate '${identityHash(record.identity)}' did not admit the authoritative compacted projection.`, candidate: record.candidate });
      } else record.state = Object.freeze({ kind: 'exhausted', attempts: record.state.attempts, lastFailure: null });
    }
    const priorContextFailure = contextRecord.state.failure;
    state.authoritativeCompactionSpent = true;
    contextRecord.state = Object.freeze({ kind: 'retry_ready', wait: 'standard' as const, attempts: contextRecord.state.attempts, lastFailure: priorContextFailure.originalFailure });
    const mandatory = await this.attemptRecord(state, contextRecord, true);
    if (mandatory) return mandatory;
    return this.runScheduler(state, null);
  }

  preflightPinnedContentPolicyRequest(request: InvocationRequest, candidate: Candidate): PinnedContentPolicyPreflight {
    if (!request.preparedCompaction) throw new Error('Pinned content-policy preflight requires prepared compaction.');
    if (request.routePass.kind !== 'pinned-content-policy-retry' || !candidatesEqual(request.routePass.candidate, candidate))
      throw new Error('Pinned content-policy preflight candidate does not match the route authority.');
    this.registry.assertCandidate(candidate);
    const verdict = this.classifyCandidate(request as PreparedPrimaryRequest, candidate);
    const diagnostic = admissionDiagnostic([verdict]);
    if (verdict.kind !== 'admitted') return Object.freeze({ kind: 'rejected', candidate: identity(candidate), verdict, diagnostic });
    return new PinnedContentPolicyAdmission(this.#owner, request, verdict.plan);
  }

  async executePinnedContentPolicyRequest(preflight: Extract<PinnedContentPolicyPreflight, { kind: 'admitted' }>): Promise<ProviderTurnCompletion> {
    if (!(preflight instanceof PinnedContentPolicyAdmission) || !preflight.belongsTo(this.#owner) || preflight.bindingSha256 !== pinnedBindingSha256(preflight.request, preflight.plan))
      throw new Error('Pinned execution requires its exact admitted preflight object.');
    const request = preflight.request;
    const options = optionsFor(request);
    try {
      throwIfAborted(request.abortSignal);
      const completion = await this.executePlan(request, preflight.plan, options);
      const attempts = indexProviderExchangeAttempts(request.inputId, 0, completion.provider_exchanges);
      throwIfAborted(request.abortSignal);
      return { ...completion, provider_exchanges: attempts };
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if (error instanceof CandidateRequestPlanIntegrityError || error instanceof CandidateAdmissionIntegrityError) throw error;
      if (error instanceof ProviderTurnFailure) {
        const attempts = error.failure_phase === 'provider_attempt' ? indexProviderExchangeAttempts(request.inputId, 0, error.provider_exchanges) : [];
        throw new ProviderTurnFailure({ failure_phase: attempts.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: attempts, originalFailure: error.originalFailure, candidate: preflight.plan.candidate });
      }
      throw new ProviderTurnFailure({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: error, candidate: preflight.plan.candidate });
    }
  }

  async invokeInternalSummary(request: InvocationRequest): Promise<ProviderTurnCompletion> {
    if (request.preparedCompaction) throw new Error('Internal summary invocation must not use primary prepared admission.');
    if (request.routePass.kind !== 'ordinary' || request.routePass.candidateChain.length !== 1)
      throw new Error('Internal summary invocation requires exactly one ordinary candidate.');
    const candidate = request.routePass.candidateChain[0]!;
    this.registry.assertCandidate(candidate);
    const capabilities = this.registry.getEffectiveCapabilities(candidate);
    const match = supportsCapabilityRequest(capabilities, request.capabilityRequest);
    if (!match.supported) throw new Error(`Internal summary candidate is capability-ineligible: ${match.reasons.join(', ')}.`);
    const options = optionsFor(request);
    const plan = buildCandidateRequest({ candidate, capabilities, adapter: selectLlmProtocolAdapter(capabilities.transportProtocol), instructionText: request.prefix.instructionText, dynamicBlocks: request.dynamicBlocks, providerConversation: request.providerConversation, options });
    const settled: ProviderExchangeAttempt[] = [];
    let lastFailure: unknown = null;
    const deadlineMs = Date.now() + LLM_UNAVAILABILITY_TIMEOUT_MS;
    for (let attempt = 0; attempt < 1 + this.maxRecoveryRetries;) {
      throwIfAborted(request.abortSignal);
      if (!this.candidateAvailability.isAvailable(candidate)) {
        const entry = this.candidateAvailability.getEntry(candidate);
        if (!entry || !entry.reason || !WAITABLE_UNAVAILABILITY_REASONS.has(entry.reason)) break;
        const wait = waitUntil(entry.untilMs, Date.now(), deadlineMs);
        if (wait.kind === 'timeout') break;
        await delayWithAbort(wait.waitMs, request.abortSignal);
        continue;
      }
      try {
        const completion = await this.executePlan(request, plan, options);
        settled.push(...indexProviderExchangeAttempts(request.inputId, settled.length, completion.provider_exchanges));
        this.candidateAvailability.markSucceeded(candidate);
        return { ...completion, provider_exchanges: settled };
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof CandidateRequestPlanIntegrityError || error instanceof CandidateAdmissionIntegrityError) throw error;
        const failure = error instanceof ProviderTurnFailure ? error : new ProviderTurnFailure({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: error, candidate });
        if (failure.failure_phase === 'provider_attempt') settled.push(...indexProviderExchangeAttempts(request.inputId, settled.length, failure.provider_exchanges));
        attempt++;
        lastFailure = failure.originalFailure;
        const decision = defaultInvocationRecoveryPolicy.decideFailure(failure.originalFailure, { candidate, recoveryDelayMs: this.recoveryDelayMs });
        if (decision.availability) this.candidateAvailability.markFailed(candidate, decision.availability);
        if (decision.kind === 'terminal' || attempt >= 1 + this.maxRecoveryRetries)
          throw new ProviderTurnFailure({ failure_phase: settled.length ? 'provider_attempt' : 'pre_provider', provider_exchanges: settled, originalFailure: failure.originalFailure, candidate });
        const untilMs = decision.wait === 'rate-limit' ? decision.availability.untilMs : Date.now() + decision.retryDelayMs;
        const wait = waitUntil(untilMs, Date.now(), deadlineMs);
        if (wait.kind === 'timeout') break;
        await delayWithAbort(wait.waitMs, request.abortSignal);
      }
    }
    throw new ProviderTurnFailure({ failure_phase: settled.length ? 'provider_attempt' : 'pre_provider', provider_exchanges: settled, originalFailure: lastFailure ?? new Error(`No healthy candidates available for agent '${request.agentName}'.`), candidate });
  }

  projectProviderExchanges(sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], context: ProviderExchangePublicationContext): void {
    const hasOk = attempts.some((attempt) => attempt.status === 'ok');
    if (context.terminalConversationOutputId !== null && hasOk) throw new Error('A terminal conversation output id cannot be published with a successful provider attempt.');
    if (context.assistantOutputIds.length > 0 && !hasOk) throw new Error('Assistant output ids require a successful provider attempt.');
    for (const attempt of attempts) {
      appendAppLogEntry(this.projectRoot, 'provider_exchange', () => {
        if (attempt.attempt_index === undefined) throw new Error(`Provider exchange for '${sourceInputId}' is missing attempt_index.`);
        if (attempt.source_input_id !== sourceInputId) throw new Error(`Provider exchange source_input_id '${attempt.source_input_id}' does not match '${sourceInputId}'.`);
        const payload = projectProviderExchangeForPublication(attempt as ProviderExchangeAttempt & { attempt_index: number }, attempt.status === 'ok' ? { assistantOutputIds: context.assistantOutputIds, terminalConversationOutputId: null } : { assistantOutputIds: [], terminalConversationOutputId: hasOk ? null : context.terminalConversationOutputId });
        return { type: 'provider_exchange', data: { session_id: sessionId, source_input_id: sourceInputId, attempt_index: attempt.attempt_index, timestamp: attempt.completed_at, payload } };
      });
      const parsed = ConversationSessionIdSchema.safeParse(sessionId);
      if (parsed.success) this.freshness.llmExchangeChanged(parsed.data);
    }
  }

  private classifyCandidate(request: PreparedPrimaryRequest, candidate: Candidate): CandidateLocalAdmission {
    this.registry.assertCandidate(candidate);
    const capabilities = this.registry.getEffectiveCapabilities(candidate);
    const capabilityRequest = Object.freeze(structuredClone(request.capabilityRequest));
    const capabilityRequestSha256 = sha256(canonicalJson(capabilityRequest));
    const options = optionsFor(request);
    const plan = buildCandidateRequest({ candidate, capabilities, adapter: selectLlmProtocolAdapter(capabilities.transportProtocol), instructionText: request.prefix.instructionText, dynamicBlocks: request.dynamicBlocks, providerConversation: request.providerConversation, options });
    const common = { candidate: identity(candidate), capabilityRequest, capabilityRequestSha256 };
    const match = supportsCapabilityRequest(capabilities, capabilityRequest);
    if (!match.supported) return Object.freeze({ ...common, kind: 'candidate_ineligible', reason: Object.freeze({ kind: 'capability_mismatch', reasons: Object.freeze([...match.reasons]) }) });
    if (capabilities.contextWindowTokens === undefined) return Object.freeze({ ...common, kind: 'candidate_ineligible', reason: Object.freeze({ kind: 'missing_context_window' }) });
    if (capabilities.maxOutputTokens === undefined) return Object.freeze({ ...common, kind: 'candidate_ineligible', reason: Object.freeze({ kind: 'missing_max_output' }) });
    const requested = request.preparedCompaction.requestedCompletionTokens;
    if (requested > request.preparedCompaction.reservedCompletionTokens || requested > capabilities.maxOutputTokens)
      return Object.freeze({ ...common, kind: 'candidate_ineligible', reason: Object.freeze({ kind: 'max_output_too_small' }) });
    if (plan.request.estimatedWireInputTokens + requested > request.preparedCompaction.inputBudgetTokens || plan.request.estimatedWireInputTokens + requested > capabilities.contextWindowTokens)
      return Object.freeze({ ...common, kind: 'projection_too_large', protocol: capabilities.transportProtocol, requestHash: plan.request.requestHash, serializedBytes: Buffer.byteLength(plan.request.serializedBody, 'utf8'), estimatedInputTokens: plan.request.estimatedWireInputTokens, requestedCompletionTokens: requested, inputBudgetTokens: request.preparedCompaction.inputBudgetTokens, contextWindowTokens: capabilities.contextWindowTokens });
    return Object.freeze({ ...common, kind: 'admitted', plan });
  }

  private assertAdmission(admission: OrdinaryPrimaryAdmission): void {
    if (!(admission instanceof OrdinaryPrimaryAdmission)) throw new Error('Ordinary execution requires an admitted request object.');
    if (requestBindingSha256(admission.request, admission.executionAuthority) !== admission.bindingSha256) throw new Error('Ordinary admitted request binding changed before execution.');
  }

  private createExecutionState(admission: OrdinaryPrimaryAdmission): LiveExecutionState {
    return {
      admission,
      records: admission.candidates.flatMap((verdict, routeIndex) => verdict.kind === 'admitted' ? [{ identity: identity(verdict.plan.candidate), routeIndex, candidate: verdict.plan.candidate, state: Object.freeze({ kind: 'untried' as const, attempts: 0 as const }), plan: verdict.plan }] : []),
      options: optionsFor(admission.request),
      deadlineMs: Date.now() + LLM_UNAVAILABILITY_TIMEOUT_MS,
      settledProviderAttempts: [],
      lastFailure: null,
      resumed: false,
      authoritativeCompactionSpent: false,
    };
  }

  private async runScheduler(state: LiveExecutionState, mandatoryRecord: MutableExecutionRecord | null): Promise<ProviderTurnCompletion> {
    for (;;) {
      throwIfAborted(state.admission.request.abortSignal);
      this.refreshReadyStates(state.records);
      const next = this.nextCandidateState(state.records, state.deadlineMs);
      if (next.kind === 'timeout') return this.throwExecutionFailure(state, `No LLM candidate became available for agent '${state.admission.request.agentName}' within ${LLM_UNAVAILABILITY_TIMEOUT_MS}ms.`);
      if (next.kind === 'wait') { await delayWithAbort(next.waitMs, state.admission.request.abortSignal); continue; }
      if (next.kind === 'none') return this.throwExecutionFailure(state, `No healthy candidates available for agent '${state.admission.request.agentName}'.`);
      const result = await this.attemptRecord(state, next.record, mandatoryRecord === next.record);
      if (result) return result;
      mandatoryRecord = null;
    }
  }

  private async attemptRecord(state: LiveExecutionState, record: MutableExecutionRecord, authoritativeRetry: boolean): Promise<ProviderTurnCompletion | null> {
    const request = state.admission.request;
    const candidate = record.candidate;
    try {
      const result = await this.executePlan(request, record.plan, state.options);
      state.settledProviderAttempts.push(...indexProviderExchangeAttempts(request.inputId, state.settledProviderAttempts.length, result.provider_exchanges));
      throwIfAborted(request.abortSignal);
      this.candidateAvailability.markSucceeded(candidate);
      return { result: result.result, provider_exchanges: state.settledProviderAttempts, provider_private_context: result.provider_private_context };
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if (error instanceof CandidateRequestPlanIntegrityError || error instanceof CandidateAdmissionIntegrityError) throw error;
      if (isAbortFromSignal(error, request.abortSignal)) throw error;
      const failure = error instanceof ProviderTurnFailure ? error : new ProviderTurnFailure({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: error, candidate });
      if (failure.failure_phase === 'provider_attempt') {
        if (failure.provider_exchanges.length === 0) throw new Error(`Provider attempt for input '${request.inputId}' settled without a provider_exchange envelope.`);
        state.settledProviderAttempts.push(...indexProviderExchangeAttempts(request.inputId, state.settledProviderAttempts.length, failure.provider_exchanges));
      }
      const attempts = record.state.attempts + 1;
      if (failure.failure_phase === 'provider_attempt' && unwrapFailure(failure.originalFailure).kind === 'input_context_exhausted') {
        const normalized = new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: state.settledProviderAttempts, originalFailure: failure.originalFailure, message: failure.message, candidate });
        if (authoritativeRetry || state.authoritativeCompactionSpent) throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: state.settledProviderAttempts, originalFailure: failure.originalFailure, message: 'Provider input context remained exhausted after one authoritative compacted retry.', candidate });
        record.state = Object.freeze({ kind: 'context_failed', attempts, failure: normalized });
        throw new AdmittedProviderTurnFailure(normalized, new SuspendedAdmittedExecution(this.#owner, state, record.identity));
      }
      const decision = defaultInvocationRecoveryPolicy.decideFailure(failure.originalFailure, { candidate, recoveryDelayMs: this.recoveryDelayMs });
      if (decision.availability) { throwIfAborted(request.abortSignal); this.candidateAvailability.markFailed(candidate, decision.availability); }
      if (decision.kind === 'terminal') throw new ProviderTurnFailure({ failure_phase: state.settledProviderAttempts.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: state.settledProviderAttempts, originalFailure: failure.originalFailure, candidate });
      state.lastFailure = failure.originalFailure;
      if (attempts >= 1 + this.maxRecoveryRetries) { record.state = Object.freeze({ kind: 'exhausted', attempts, lastFailure: failure.originalFailure }); return null; }
      const untilMs = decision.wait === 'rate-limit' ? decision.availability.untilMs : Date.now() + decision.retryDelayMs;
      record.state = Object.freeze({ kind: 'retry_waiting', wait: decision.wait === 'rate-limit' ? 'rate_limit' as const : 'standard' as const, attempts, untilMs, lastFailure: failure.originalFailure });
      return null;
    }
  }

  protected async executePlan(request: InvocationRequest, plan: CandidateRequestPlan, options: LlmCompleteOptions): Promise<ProviderTurnCompletion> {
    return executeLlmProviderAttempt({ projectRoot: this.projectRoot, registry: this.registry, sessionId: request.sessionId, plan, options, capabilityRequest: request.capabilityRequest });
  }

  private refreshReadyStates(records: MutableExecutionRecord[]): void {
    const now = Date.now();
    for (const record of records) {
      if (record.state.kind === 'retry_waiting' && record.state.untilMs <= now)
        record.state = Object.freeze({ kind: 'retry_ready', wait: record.state.wait, attempts: record.state.attempts, lastFailure: record.state.lastFailure });
      if (record.state.kind === 'temporarily_unavailable' && this.candidateAvailability.isAvailable(record.candidate))
        record.state = Object.freeze(record.state.attempts === 0 ? { kind: 'untried', attempts: 0 } : { kind: 'retry_ready', wait: 'standard', attempts: record.state.attempts, lastFailure: new Error('Candidate availability wait elapsed.') });
      if (record.state.kind === 'untried' && !this.candidateAvailability.isAvailable(record.candidate)) {
        const entry = this.candidateAvailability.getEntry(record.candidate);
        if (entry && entry.reason && WAITABLE_UNAVAILABILITY_REASONS.has(entry.reason)) record.state = Object.freeze({ kind: 'temporarily_unavailable', attempts: 0, untilMs: entry.untilMs, reason: entry.reason });
        else record.state = Object.freeze({ kind: 'exhausted', attempts: 0, lastFailure: null });
      }
    }
  }

  private nextCandidateState(records: MutableExecutionRecord[], deadlineMs: number): { kind: 'attempt'; record: MutableExecutionRecord } | { kind: 'wait'; waitMs: number } | { kind: 'timeout' } | { kind: 'none' } {
    const now = Date.now();
    const standardWaiting = records.find((record) => record.state.kind === 'retry_waiting' && record.state.wait === 'standard');
    if (standardWaiting && standardWaiting.state.kind === 'retry_waiting') return waitUntil(standardWaiting.state.untilMs, now, deadlineMs);
    const standardReady = records.find((record) => record.state.kind === 'retry_ready' && record.state.wait === 'standard');
    if (standardReady) return { kind: 'attempt', record: standardReady };
    const untried = records.find((record) => record.state.kind === 'untried');
    if (untried) return { kind: 'attempt', record: untried };
    const rateReady = records.find((record) => record.state.kind === 'retry_ready' && record.state.wait === 'rate_limit');
    if (rateReady) return { kind: 'attempt', record: rateReady };
    const waitingUntil = records.flatMap((record) => record.state.kind === 'retry_waiting' && record.state.wait === 'rate_limit' || record.state.kind === 'temporarily_unavailable' ? [record.state.untilMs] : []).sort((a, b) => a - b)[0];
    if (waitingUntil !== undefined) return waitUntil(waitingUntil, now, deadlineMs);
    return { kind: 'none' };
  }

  private throwExecutionFailure(state: LiveExecutionState, message: string): never {
    throw new ProviderTurnFailure({ failure_phase: state.settledProviderAttempts.length > 0 ? 'provider_attempt' : 'pre_provider', provider_exchanges: state.settledProviderAttempts, originalFailure: state.lastFailure ?? new Error(message), message, candidate: null });
  }
}

function optionsFor(request: InvocationRequest): LlmCompleteOptions {
  const outputTokens = request.preparedCompaction?.requestedCompletionTokens ?? request.modelParams.maxTokens;
  if (outputTokens === undefined) throw new Error('Invocation request has no completion token request.');
  return buildLlmOptions(request.agentName, request.compiledTools.map((tool) => tool.providerDefinition), request.prefix.terminalToolNames, { temperature: request.modelParams.temperature, max_tokens: outputTokens }, request.abortSignal, request.inputId);
}

function identity(candidate: CandidateIdentity): CandidateIdentity {
  return Object.freeze({ provider: candidate.provider, account: candidate.account, model: candidate.model });
}

function sameIdentity(left: CandidateIdentity, right: CandidateIdentity): boolean {
  return left.provider === right.provider && left.account === right.account && left.model === right.model;
}

function identityHash(value: CandidateIdentity): string { return sha256(canonicalJson(value)); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function assertUniqueCandidates(candidates: readonly Candidate[]): void {
  for (let index = 0; index < candidates.length; index++)
    if (candidates.slice(0, index).some((candidate) => candidatesEqual(candidate, candidates[index]!)))
      throw new Error(`Ordinary route contains duplicate candidate identity at index ${index}.`);
}

function requestBindingSha256(request: InvocationRequest, authority: OrdinaryAdmittedExecutionAuthority): string {
  return sha256(canonicalJson({ inputId: request.inputId, sessionId: request.sessionId, providerConversation: request.providerConversation, immutablePrefixSha256: request.prefix.immutablePrefixSha256, internalToolContractSha256: request.internalToolContractSha256, dynamicBlocksSha256: request.dynamicBlocksSha256, capabilityRequest: request.capabilityRequest, requestedCompletionTokens: request.preparedCompaction?.requestedCompletionTokens, authority }));
}

function pinnedBindingSha256(request: InvocationRequest, plan: CandidateRequestPlan): string {
  return sha256(canonicalJson({
    inputId: request.inputId,
    sessionId: request.sessionId,
    immutablePrefixSha256: request.prefix.immutablePrefixSha256,
    internalToolContractSha256: request.internalToolContractSha256,
    dynamicBlocksSha256: request.dynamicBlocksSha256,
    capabilityRequest: request.capabilityRequest,
    routePass: request.routePass,
    requestedCompletionTokens: request.preparedCompaction?.requestedCompletionTokens,
    candidate: plan.candidate,
    requestHash: plan.request.requestHash,
  }));
}

function assertRecoveryRequestBindings(original: InvocationRequest, compacted: InvocationRequest, authority: OrdinaryAdmittedExecutionAuthority): void {
  if (!compacted.preparedCompaction || compacted.routePass.kind !== 'ordinary') throw new Error('Authoritative recovery requires a prepared ordinary request.');
  assertProviderConversationSourceRows(compacted.providerConversation);
  const fields = ['inputId', 'sessionId', 'internalToolContractSha256', 'dynamicBlocksSha256'] as const;
  for (const field of fields) if (original[field] !== compacted[field]) throw new Error(`Authoritative recovery changed '${field}'.`);
  if (original.prefix.immutablePrefixSha256 !== compacted.prefix.immutablePrefixSha256 || original.prefix.immutablePrefixBytes !== compacted.prefix.immutablePrefixBytes) throw new Error('Authoritative recovery changed the static prefix.');
  if (canonicalJson(original.capabilityRequest) !== canonicalJson(compacted.capabilityRequest)) throw new Error('Authoritative recovery changed the capability request.');
  if (original.providerConversation.sourceSessionId !== compacted.providerConversation.sourceSessionId) throw new Error('Authoritative recovery changed the conversation source session.');
  if (canonicalJson(original.routePass) !== canonicalJson(compacted.routePass)) throw new Error('Authoritative recovery changed the ordinary route pass.');
  if (canonicalJson(original.modelParams) !== canonicalJson(compacted.modelParams)) throw new Error('Authoritative recovery changed model parameters.');
  if (canonicalJson(original.preparedCompaction) !== canonicalJson(compacted.preparedCompaction)) throw new Error('Authoritative recovery changed prepared compaction capacity.');
  if (authority.admittedCandidateIdentitiesSha256 !== sha256(canonicalJson(authority.admittedCandidateIdentities))) throw new Error('Authoritative recovery membership hash is malformed.');
}

function validateSuspendedState(state: LiveExecutionState, contextIdentity: CandidateIdentity): void {
  const authority = state.admission.executionAuthority;
  if (state.records.length !== authority.admittedCandidateIdentities.length) throw new Error('Suspended execution record count disagrees with admitted membership.');
  let contextCount = 0;
  state.records.forEach((record, index) => {
    if ((index > 0 && record.routeIndex <= state.records[index - 1]!.routeIndex) || !sameIdentity(record.identity, authority.admittedCandidateIdentities[index]!)) throw new Error('Suspended execution records are reordered or malformed.');
    if (record.state.kind === 'context_failed') { contextCount++; if (!sameIdentity(record.identity, contextIdentity)) throw new Error('Suspended execution context-failed identity disagrees with its record.'); }
  });
  if (contextCount !== 1) throw new Error(`Suspended execution requires exactly one context-failed record; found ${contextCount}.`);
  state.settledProviderAttempts.forEach((attempt, index) => { if (attempt.attempt_index !== index || attempt.source_input_id !== state.admission.request.inputId) throw new Error('Suspended execution provider attempts are not contiguous and bound to the input.'); });
}

function admissionDiagnostic(candidates: readonly CandidateLocalAdmission[]): AdmissionDiagnostic {
  const summary = candidates.map((value) => ({ identity: value.candidate, verdict: verdictName(value), capabilityReasons: value.kind === 'candidate_ineligible' && value.reason.kind === 'capability_mismatch' ? value.reason.reasons : [] }));
  const counts: Record<string, number> = { admitted: 0, projection_too_large: 0, capability_mismatch: 0, missing_context_window: 0, missing_max_output: 0, max_output_too_small: 0 };
  for (const value of summary) counts[value.verdict] = (counts[value.verdict] ?? 0) + 1;
  const displayed = candidates.slice(0, DIAGNOSTIC_CANDIDATE_LIMIT).map((value, routeIndex) => Object.freeze({ routeIndex, candidateIdentitySha256: identityHash(value.candidate), providerPreview: utf8Preview(value.candidate.provider), modelPreview: utf8Preview(value.candidate.model), accountPresent: value.candidate.account !== null, verdict: verdictName(value), ...(value.kind === 'candidate_ineligible' && value.reason.kind === 'capability_mismatch' ? { capabilityReasons: value.reason.reasons } : {}) }));
  return Object.freeze({ verdictSha256: sha256(canonicalJson(summary)), totalCandidates: candidates.length, omittedCandidateCount: Math.max(0, candidates.length - DIAGNOSTIC_CANDIDATE_LIMIT), counts: Object.freeze(counts), candidates: Object.freeze(displayed) });
}

function verdictName(value: CandidateLocalAdmission): string { return value.kind === 'candidate_ineligible' ? value.reason.kind : value.kind; }

function recoveryDiagnostic(state: LiveExecutionState, contextIdentity: CandidateIdentity) {
  const counts: Record<string, number> = { untried: 0, temporarily_unavailable: 0, retry_waiting: 0, retry_ready: 0, context_failed: 0, exhausted: 0 };
  for (const record of state.records) counts[record.state.kind] = (counts[record.state.kind] ?? 0) + 1;
  const candidates = state.records.slice(0, DIAGNOSTIC_CANDIDATE_LIMIT).map((record) => Object.freeze({ routeIndex: record.routeIndex, candidateIdentitySha256: identityHash(record.identity), providerPreview: utf8Preview(record.identity.provider), modelPreview: utf8Preview(record.identity.model), accountPresent: record.identity.account !== null, state: record.state.kind }));
  return Object.freeze({ candidateScope: 'retained_original_admission_state' as const, admittedCount: state.admission.executionAuthority.admittedCandidateIdentities.length, admittedHash: state.admission.executionAuthority.admittedCandidateIdentitiesSha256, contextFailedIdentitySha256: identityHash(contextIdentity), stateCounts: Object.freeze(counts), omittedCandidateCount: Math.max(0, state.records.length - DIAGNOSTIC_CANDIDATE_LIMIT), candidates: Object.freeze(candidates) });
}

function utf8Preview(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= DIAGNOSTIC_PREVIEW_BYTES) return value;
  let end = DIAGNOSTIC_PREVIEW_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function waitUntil(untilMs: number, now: number, deadlineMs: number): { kind: 'wait'; waitMs: number } | { kind: 'timeout' } {
  const remainingMs = deadlineMs - now;
  if (remainingMs <= 0) return { kind: 'timeout' };
  return { kind: 'wait', waitMs: Math.min(Math.max(0, untilMs - now), remainingMs) };
}

function delayWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delayMs);
    const onAbort = () => { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); reject(abortReason(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw abortReason(signal); }
function abortReason(signal?: AbortSignal): unknown { if (signal?.reason !== undefined) return signal.reason; if (typeof DOMException !== 'undefined') return new DOMException('The operation was aborted.', 'AbortError'); const error = new Error('The operation was aborted.'); error.name = 'AbortError'; return error; }
function isAbortFromSignal(error: unknown, signal?: AbortSignal): boolean { return Boolean(signal?.aborted && (error === signal.reason || error instanceof Error && error.name === 'AbortError')); }

function indexProviderExchangeAttempts(sourceInputId: string, offset: number, attempts: ProviderExchangeAttempt[]): ProviderExchangeAttempt[] {
  return attempts.map((attempt, index) => ({ ...attempt, source_input_id: sourceInputId, attempt_index: offset + index }));
}
