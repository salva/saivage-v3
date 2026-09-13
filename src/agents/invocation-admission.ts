import { createHash } from 'node:crypto';
import { canonicalJson } from '../schemas/index.js';
import type { AgentName } from '../schemas/index.js';
import { candidatesEqual, type Candidate } from '../contracts/provider-candidate.js';
import type { CapabilitySkipReason } from './provider-capabilities.js';
import type { CandidateRequestPlan } from './candidate-request.js';
import type { ProviderTurnFailure } from './llm-contracts.js';
import type { LlmCompleteOptions } from './llm-contracts.js';
import type { ProviderExchangeAttempt } from '../contracts/provider-exchange.js';
import type { CapabilityRequest, CapabilityMatch, EffectiveProviderCapabilities } from './provider-capabilities.js';
import type { InvocationRoutePass } from '../runtime/actors/llm-invocation.js';
import { utf8SafeSlice } from '../tools/response-packer.js';
import { usableInputTokens } from './context-budget.js';

type CandidateIdentity = Candidate;

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export const candidateIdentitySha256 = (identity: CandidateIdentity): string => sha256(canonicalJson({ provider: identity.provider, account: identity.account, model: identity.model }));
export const capabilityRequestSha256 = (request: Readonly<CapabilityRequest>): string => sha256(canonicalJson(request));

type CandidateIneligibleReason =
  | Readonly<{ kind: 'capability_mismatch'; reasons: readonly CapabilitySkipReason[] }>
  | Readonly<{ kind: 'missing_context_window' }>
  | Readonly<{ kind: 'missing_max_output' }>
  | Readonly<{ kind: 'max_output_too_small' }>
  | Readonly<{ kind: 'nonpositive_usable_input' }>;

export type CandidateLocalAdmissionVerdict =
  | Readonly<{ kind: 'admitted'; plan: CandidateRequestPlan }>
  | Readonly<{
      kind: 'projection_too_large';
      protocol: string;
      requestHash: string;
      serializedBytes: number;
      estimatedInputTokens: number;
      requestedCompletionTokens: number;
      usableInputTokens: number;
      contextWindowTokens: number;
    }>
  | Readonly<{ kind: 'candidate_ineligible'; reason: CandidateIneligibleReason }>;

export type CandidateLocalAdmission = Readonly<{
  candidate: Candidate;
  capabilityRequest: Readonly<CapabilityRequest>;
  capabilityRequestSha256: string;
}> &
  CandidateLocalAdmissionVerdict;

export type AdmissionSizeLimits = Readonly<{
  contextUtilizationFraction: number | null;
  requestedCompletionTokens: number;
}>;

export function classifyCandidateLocalAdmission(args: {
  capabilities: EffectiveProviderCapabilities;
  match: CapabilityMatch;
  plan: CandidateRequestPlan;
  limits: AdmissionSizeLimits;
}): CandidateLocalAdmissionVerdict {
  if (!args.match.supported)
    return { kind: 'candidate_ineligible', reason: { kind: 'capability_mismatch', reasons: [...new Set(args.match.reasons)] } };
  if (args.capabilities.contextWindowTokens === undefined)
    return { kind: 'candidate_ineligible', reason: { kind: 'missing_context_window' } };
  if (args.capabilities.maxOutputTokens === undefined)
    return { kind: 'candidate_ineligible', reason: { kind: 'missing_max_output' } };
  if (args.limits.requestedCompletionTokens > args.capabilities.maxOutputTokens)
    return { kind: 'candidate_ineligible', reason: { kind: 'max_output_too_small' } };
  const inputCapacity = usableInputTokens(
    args.capabilities.contextWindowTokens,
    args.limits.requestedCompletionTokens,
    args.limits.contextUtilizationFraction ?? 1,
  );
  if (inputCapacity <= 0)
    return { kind: 'candidate_ineligible', reason: { kind: 'nonpositive_usable_input' } };
  if (args.plan.request.estimatedWireInputTokens > inputCapacity)
    return {
      kind: 'projection_too_large',
      protocol: args.capabilities.transportProtocol,
      requestHash: args.plan.request.requestHash,
      serializedBytes: Buffer.byteLength(args.plan.request.serializedBody, 'utf8'),
      estimatedInputTokens: args.plan.request.estimatedWireInputTokens,
      requestedCompletionTokens: args.limits.requestedCompletionTokens,
      usableInputTokens: inputCapacity,
      contextWindowTokens: args.capabilities.contextWindowTokens,
    };
  return { kind: 'admitted', plan: args.plan };
}

export type OrdinaryAdmittedExecutionAuthority = Readonly<{
  kind: 'ordinary';
  admittedCandidateIdentities: readonly CandidateIdentity[];
  admittedCandidateIdentitiesSha256: string;
}>;

export const ordinaryAdmittedExecutionAuthority = (identities: readonly CandidateIdentity[]): OrdinaryAdmittedExecutionAuthority =>
  Object.freeze({
    kind: 'ordinary',
    admittedCandidateIdentities: Object.freeze([...identities]),
    admittedCandidateIdentitiesSha256: sha256(canonicalJson([...identities])),
  });

export type OrdinaryPrimaryRequestAdmission =
  | Readonly<{
      kind: 'admitted';
      routePass: InvocationRoutePass;
      candidates: readonly CandidateLocalAdmission[];
      executionAuthority: OrdinaryAdmittedExecutionAuthority;
      bindings: AdmittedExecutionBindings;
      execution: OrdinaryAdmittedExecutionInputs;
    }>
  | Readonly<{
      kind: 'local_compaction_required';
      routePass: InvocationRoutePass;
      candidates: readonly CandidateLocalAdmission[];
      bindings: AdmittedExecutionBindings;
    }>
  | Readonly<{
      kind: 'local_admission_failed';
      routePass: InvocationRoutePass;
      candidates: readonly CandidateLocalAdmission[];
      bindings: AdmittedExecutionBindings;
    }>;

export type OrdinaryAdmittedExecution = Extract<OrdinaryPrimaryRequestAdmission, { kind: 'admitted' }>;

export type AdmittedExecutionBindings = Readonly<{
  inputId: string;
  sessionId: string;
  agentName: AgentName;
  sourceSessionId: string | null;
  systemPromptSha256: string;
  toolsSha256: string;
  terminalToolNamesSha256: string;
  capabilityRequest: Readonly<CapabilityRequest>;
  capabilityRequestSha256: string;
  temperature: number;
  requestedCompletionTokens: number;
  contextUtilizationFraction: number | null;
  preparedCompactionSha256: string;
}>;

export type OrdinaryAdmittedExecutionInputs = Readonly<{
  capabilityRequest: Readonly<CapabilityRequest>;
  options: LlmCompleteOptions;
}>;

export type PinnedContentPolicyPreflight =
  | Readonly<{ kind: 'admitted'; plan: CandidateRequestPlan; candidate: Candidate; capabilityRequest: Readonly<CapabilityRequest>; inputId: string; options: LlmCompleteOptions }>
  | Readonly<{
      kind: 'rejected';
      candidate: Candidate;
      verdict: Extract<CandidateLocalAdmission, { kind: 'candidate_ineligible' | 'projection_too_large' }>;
    }>;

export type PinnedAdmittedContentPolicyRequest = Extract<PinnedContentPolicyPreflight, { kind: 'admitted' }>;

export type AdmittedCandidateAttemptState =
  | Readonly<{ kind: 'untried'; attempts: 0 }>
  | Readonly<{ kind: 'temporarily_unavailable'; attempts: number; untilMs: number; reason: string | undefined }>
  | Readonly<{ kind: 'retry_waiting'; wait: 'standard' | 'rate_limit'; attempts: number; untilMs: number; lastFailure: unknown }>
  | Readonly<{ kind: 'retry_ready'; wait: 'standard' | 'rate_limit'; attempts: number; lastFailure: unknown }>
  | Readonly<{ kind: 'context_failed'; attempts: number; failure: ProviderTurnFailure }>
  | Readonly<{ kind: 'exhausted'; attempts: number; lastFailure: unknown | null }>;

type AdmittedCandidateAttemptStateKind = AdmittedCandidateAttemptState['kind'];

type AdmittedCandidateExecutionRecord = {
  readonly identity: CandidateIdentity;
  readonly routeIndex: number;
  state: AdmittedCandidateAttemptState;
};

export type SuspendedAdmittedExecution = Readonly<{
  authority: OrdinaryAdmittedExecutionAuthority;
  records: readonly Readonly<AdmittedCandidateExecutionRecord>[];
  contextFailedIdentity: CandidateIdentity;
  settledProviderAttempts: readonly ProviderExchangeAttempt[];
  deadlineMs: number;
  bindings: AdmittedExecutionBindings;
}>;

export type AdmittedRecoveryPreparation = Readonly<{
  kind: 'recovery_prepared';
  authority: OrdinaryAdmittedExecutionAuthority;
  bindings: AdmittedExecutionBindings;
  records: readonly Readonly<AdmittedCandidateExecutionRecord>[];
  plans: readonly { routeIndex: number; plan: CandidateRequestPlan }[];
  mandatoryFirstIdentity: CandidateIdentity;
  settledProviderAttempts: readonly ProviderExchangeAttempt[];
  deadlineMs: number;
  execution: OrdinaryAdmittedExecutionInputs;
}>;

export class AdmissionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdmissionIntegrityError';
  }
}

export class AdmittedRecoveryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdmittedRecoveryIntegrityError';
  }
}

export class AdmittedProviderTurnFailure extends Error {
  readonly turnFailure: ProviderTurnFailure;
  readonly suspension: SuspendedAdmittedExecution;
  constructor(turnFailure: ProviderTurnFailure, suspension: SuspendedAdmittedExecution) {
    super(turnFailure.message, { cause: turnFailure });
    this.name = 'AdmittedProviderTurnFailure';
    this.turnFailure = turnFailure;
    this.suspension = suspension;
  }
}

type AdmissionCandidateDiagnostic = Readonly<{
  routeIndex: number;
  candidateIdentitySha256: string;
  providerPreview: string;
  modelPreview: string;
  accountPresent: boolean;
  verdict: 'admitted' | 'projection_too_large' | 'candidate_ineligible';
  ineligibleReason: CandidateIneligibleReason | null;
}>;

type AdmissionDiagnostics = Readonly<{
  verdictCounts: Readonly<{ admitted: number; projection_too_large: number; candidate_ineligible: number }>;
  reasonCounts: Readonly<{ capability_mismatch: number; missing_context_window: number; missing_max_output: number; max_output_too_small: number; nonpositive_usable_input: number }>;
  verdictSummarySha256: string;
  candidates: readonly AdmissionCandidateDiagnostic[];
  omittedCandidateCount: number;
}>;

const PREVIEW_MAX_BYTES = 128;
const DIAGNOSTIC_CANDIDATE_CAP = 32;
const ELLIPSIS_BYTES = 3;

function utf8TruncatingPreview(value: string, maxBytes = PREVIEW_MAX_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const prefix = utf8SafeSlice(value, 0, Math.max(0, maxBytes - ELLIPSIS_BYTES)).content;
  return `${prefix}…`;
}

const verdictSummary = (candidates: readonly CandidateLocalAdmission[]): string =>
  canonicalJson(
    candidates.map((verdict) => ({
      identity: candidateIdentitySha256(verdict.candidate),
      kind: verdict.kind,
      ...(verdict.kind === 'candidate_ineligible' ? { reason: verdict.reason.kind } : {}),
      ...(verdict.kind === 'projection_too_large' ? { estimatedInputTokens: verdict.estimatedInputTokens } : {}),
    })),
  );

export function projectAdmissionDiagnostics(candidates: readonly CandidateLocalAdmission[]): AdmissionDiagnostics {
  const verdictCounts = { admitted: 0, projection_too_large: 0, candidate_ineligible: 0 };
  const reasonCounts = { capability_mismatch: 0, missing_context_window: 0, missing_max_output: 0, max_output_too_small: 0, nonpositive_usable_input: 0 };
  const displayed: AdmissionCandidateDiagnostic[] = [];
  for (const [routeIndex, verdict] of candidates.entries()) {
    verdictCounts[verdict.kind] += 1;
    if (verdict.kind === 'candidate_ineligible') reasonCounts[verdict.reason.kind] += 1;
    if (displayed.length >= DIAGNOSTIC_CANDIDATE_CAP) continue;
    displayed.push({
      routeIndex,
      candidateIdentitySha256: candidateIdentitySha256(verdict.candidate),
      providerPreview: utf8TruncatingPreview(verdict.candidate.provider),
      modelPreview: utf8TruncatingPreview(verdict.candidate.model),
      accountPresent: verdict.candidate.account !== null,
      verdict: verdict.kind,
      ineligibleReason: verdict.kind === 'candidate_ineligible' ? verdict.reason : null,
    });
  }
  return Object.freeze({
    verdictCounts: Object.freeze(verdictCounts),
    reasonCounts: Object.freeze(reasonCounts),
    verdictSummarySha256: sha256(verdictSummary(candidates)),
    candidates: Object.freeze(displayed),
    omittedCandidateCount: Math.max(0, candidates.length - DIAGNOSTIC_CANDIDATE_CAP),
  });
}

const STATE_KINDS: readonly AdmittedCandidateAttemptStateKind[] = [
  'untried',
  'temporarily_unavailable',
  'retry_waiting',
  'retry_ready',
  'context_failed',
  'exhausted',
];

type RetainedAdmissionStateDiagnostics = Readonly<{
  candidate_scope: 'retained_original_admission_state';
  admittedCandidateCount: number;
  admittedCandidateIdentitiesSha256: string;
  contextFailedIdentitySha256: string;
  stateCounts: Readonly<Record<AdmittedCandidateAttemptStateKind, number>>;
}>;

export function retainedAdmissionStateDiagnostics(suspension: SuspendedAdmittedExecution): RetainedAdmissionStateDiagnostics {
  const stateCounts = Object.fromEntries(STATE_KINDS.map((kind) => [kind, 0])) as Record<AdmittedCandidateAttemptStateKind, number>;
  for (const record of suspension.records) stateCounts[record.state.kind] += 1;
  return Object.freeze({
    candidate_scope: 'retained_original_admission_state',
    admittedCandidateCount: suspension.authority.admittedCandidateIdentities.length,
    admittedCandidateIdentitiesSha256: suspension.authority.admittedCandidateIdentitiesSha256,
    contextFailedIdentitySha256: candidateIdentitySha256(suspension.contextFailedIdentity),
    stateCounts: Object.freeze(stateCounts),
  });
}

export class LocalExactAdmissionError extends Error {
  readonly localCompactionAttempted: boolean;
  readonly diagnostics: AdmissionDiagnostics;
  readonly recovery: RetainedAdmissionStateDiagnostics | null;
  constructor(args: { localCompactionAttempted: boolean; diagnostics: AdmissionDiagnostics; recovery?: RetainedAdmissionStateDiagnostics; constructionDiagnostic?: string; cause?: unknown }) {
    super(
      `Ordinary exact admission failed (local_compaction_attempted=${args.localCompactionAttempted}): verdicts=${JSON.stringify(args.diagnostics.verdictCounts)}, reasons=${JSON.stringify(args.diagnostics.reasonCounts)}, candidates=${args.diagnostics.candidates.length}, omitted=${args.diagnostics.omittedCandidateCount}, verdict_summary_sha256=${args.diagnostics.verdictSummarySha256}${args.recovery ? `, recovery=${JSON.stringify(args.recovery)}` : ''}${args.constructionDiagnostic ? `, ${args.constructionDiagnostic}` : ''}`,
      { cause: args.cause },
    );
    this.name = 'LocalExactAdmissionError';
    this.localCompactionAttempted = args.localCompactionAttempted;
    this.diagnostics = args.diagnostics;
    this.recovery = args.recovery ?? null;
  }
}

export function verifySuspendedAdmittedExecution(suspension: SuspendedAdmittedExecution): void {
  const authority = suspension.authority;
  const identities = authority.admittedCandidateIdentities;
  if (identities.length === 0) throw new AdmittedRecoveryIntegrityError('Suspended admitted execution carries an empty authority membership.');
  if (authority.admittedCandidateIdentitiesSha256 !== sha256(canonicalJson([...identities])))
    throw new AdmittedRecoveryIntegrityError('Suspended admitted execution authority hash does not match its membership.');
  for (const [index, identity] of identities.entries())
    if (identities.some((other, otherIndex) => otherIndex > index && candidatesEqual(other, identity)))
      throw new AdmittedRecoveryIntegrityError('Suspended admitted execution authority membership contains a duplicate identity.');
  if (suspension.records.length !== identities.length)
    throw new AdmittedRecoveryIntegrityError(`Suspended admitted execution carries ${suspension.records.length} records for ${identities.length} authority members.`);
  let lastRouteIndex = -1;
  for (const [index, record] of suspension.records.entries()) {
    if (!candidatesEqual(record.identity, identities[index]!))
      throw new AdmittedRecoveryIntegrityError(`Suspended admitted execution record ${index} does not match authority member ${index}.`);
    if (record.routeIndex <= lastRouteIndex)
      throw new AdmittedRecoveryIntegrityError('Suspended admitted execution records are not in strictly increasing route order.');
    lastRouteIndex = record.routeIndex;
  }
  const contextFailed = suspension.records.filter(
    (record): record is Readonly<AdmittedCandidateExecutionRecord> & { state: Extract<AdmittedCandidateAttemptState, { kind: 'context_failed' }> } => record.state.kind === 'context_failed',
  );
  if (contextFailed.length !== 1)
    throw new AdmittedRecoveryIntegrityError(`Suspended admitted execution requires exactly one context-failed record, found ${contextFailed.length}.`);
  const contextFailedRecord = contextFailed[0]!;
  if (!candidatesEqual(contextFailedRecord.identity, suspension.contextFailedIdentity))
    throw new AdmittedRecoveryIntegrityError('Suspended admitted execution context-failed identity does not match its record.');
  const failure = contextFailedRecord.state.failure;
  if (failure.failure_phase !== 'provider_attempt' || !(failure.originalFailure instanceof Error))
    throw new AdmittedRecoveryIntegrityError('Suspended admitted execution context-failed record carries no authoritative provider failure.');
  for (const [index, attempt] of suspension.settledProviderAttempts.entries()) {
    if (attempt.source_input_id !== suspension.bindings.inputId)
      throw new AdmittedRecoveryIntegrityError(`Suspended settled provider attempt ${index} is not indexed under input '${suspension.bindings.inputId}'.`);
    if (attempt.attempt_index !== index)
      throw new AdmittedRecoveryIntegrityError(`Suspended settled provider attempt ${index} carries attempt_index ${attempt.attempt_index}.`);
  }
  if (!Number.isFinite(suspension.deadlineMs) || suspension.deadlineMs <= 0)
    throw new AdmittedRecoveryIntegrityError('Suspended admitted execution carries an invalid unavailability deadline.');
}
