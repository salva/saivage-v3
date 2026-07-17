import type { AgentRole } from '../schemas/index.js';
import { unwrapFailure } from './llm-errors.js';
import type { LlmTransportFailure } from '../contracts/llm-failure.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import type { AvailabilityDecision } from './candidate-availability.js';
import type { CapabilityRequest, CapabilitySkipDiagnostic } from './provider-capabilities.js';
import { redactTextForOutbound } from '../redaction/index.js';

export type InvocationRecoveryAction =
  | 'mark_succeeded'
  | 'cooldown_and_failover'
  | 'failover_without_cooldown'
  | 'retry_same_after_delay'
  | 'abort_without_retry'
  | 'fail_invocation';

export interface InvocationRecoveryContext {
  role: AgentRole | string;
  candidate?: Candidate;
  attempt: number;
  maxAttempts: number;
  recoveryDelayMs: number;
  maxRecoveryRetries: number;
  capabilityRequest?: CapabilityRequest;
  capabilitySkips?: CapabilitySkipDiagnostic[];
  sessionId?: string;
  goalId?: string;
  cardId?: string;
}

export interface InvocationRecoveryDecision {
  action: InvocationRecoveryAction;
  failure?: LlmTransportFailure;
  message: string;
  eventPayload: Record<string, unknown>;
  availability?: AvailabilityDecision;
  retryDelayMs?: number;
  markFailed: boolean;
  markSucceeded: boolean;
  appendModelIssue: boolean;
  abort: boolean;
  capabilitySkipReasons?: string[];
}

function candidateLabel(candidate?: Candidate): string {
  if (!candidate) return 'no-candidate';
  return JSON.stringify(candidate);
}

export function sanitizeRecoveryMessage(value: unknown, maxLength = 500): string {
  const text = value instanceof Error ? value.message : String(value ?? 'Unknown error');
  const redacted = redactTextForOutbound(text, 'provider.diagnostic') as string;
  if (redacted.length > maxLength) return `${redacted.slice(0, maxLength)}…`;
  return redacted;
}

function assertNever(x: never): never {
  throw new Error('Unhandled failure kind: ' + JSON.stringify(x));
}

export class InvocationRecoveryPolicy {
  classify(error: unknown): LlmTransportFailure {
    const failure = unwrapFailure(error);
    if (failure.kind === 'unknown' && error instanceof Error && (error.name === 'ZodError' || error.name === 'SyntaxError')) {
      return { kind: 'parse_error', provider: failure.provider, message: failure.message };
    }
    return failure;
  }

  decideSuccess(context: InvocationRecoveryContext): InvocationRecoveryDecision {
    return this.buildDecision(context, 'mark_succeeded', undefined, `Candidate ${candidateLabel(context.candidate)} succeeded.`, {
      markSucceeded: true,
      appendModelIssue: false,
    });
  }

  decideFailure(error: unknown, context: InvocationRecoveryContext): InvocationRecoveryDecision {
    const failure = this.classify(error);
    const sanitized = sanitizeRecoveryMessage(error);
    const candidate = candidateLabel(context.candidate);

    switch (failure.kind) {
      case 'auth_permanent':
        return this.buildDecision(context, 'fail_invocation', failure, `Candidate ${candidate} failed with permanent auth error: ${sanitized}`, {
          markFailed: true,
          availability: { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 3_600_000, reason: 'auth_permanent' },
          appendModelIssue: true,
        });
      case 'capability_mismatch':
        return this.buildDecision(context, 'fail_invocation', failure, `Candidate ${candidate} is incompatible with requested capabilities: ${sanitized}`, { appendModelIssue: true });
      case 'rate_limit': {
        const now = Date.now();
        let untilMs = 0;
        if (typeof failure.retryAfterMs === 'number' && failure.retryAfterMs > 0) {
          untilMs = now + failure.retryAfterMs;
        } else if (typeof failure.resetsAt === 'string') {
          const parsed = Date.parse(failure.resetsAt);
          if (Number.isFinite(parsed) && parsed > now) untilMs = parsed;
        }
        if (untilMs <= now) untilMs = now + Math.max(context.recoveryDelayMs, 60_000);
        return this.buildDecision(context, 'cooldown_and_failover', failure, `Candidate ${candidate} failed transiently: ${sanitized}`, {
          markFailed: true,
          availability: { state: 'BLOCKED_UNTIL', untilMs, reason: 'rate_limit' },
          appendModelIssue: true,
        });
      }
      case 'server_transient':
      case 'timeout':
        return this.buildDecision(context, 'cooldown_and_failover', failure, `Candidate ${candidate} failed transiently: ${sanitized}`, {
          markFailed: true,
          availability: { state: 'COOLING', untilMs: Date.now() + Math.max(context.recoveryDelayMs, 5_000), reason: failure.kind },
          appendModelIssue: true,
        });
      case 'provider_protocol_error':
        return this.buildDecision(context, 'fail_invocation', failure, `Candidate ${candidate} returned a malformed protocol response: ${sanitized}`, { markFailed: true, appendModelIssue: true });
      case 'input_context_exhausted':
        return this.buildDecision(context, 'fail_invocation', failure, `Candidate ${candidate} exhausted its input context: ${sanitized}`, { appendModelIssue: true });
      case 'output_token_limit_exceeded':
        return this.buildDecision(context, 'fail_invocation', failure, `Candidate ${candidate} exceeded its output token limit: ${sanitized}`, { appendModelIssue: true });
      case 'local_setup_error':
        return this.buildDecision(context, 'fail_invocation', failure, `Candidate ${candidate} has a local setup error: ${sanitized}`, { appendModelIssue: true });
      case 'parse_error': {
        const canRetrySame = context.attempt <= context.maxRecoveryRetries;
        return this.buildDecision(
          context,
          canRetrySame ? 'retry_same_after_delay' : 'failover_without_cooldown',
          failure,
          `Candidate ${candidate} produced an invalid response contract: ${sanitized}`,
          { retryDelayMs: canRetrySame ? context.recoveryDelayMs : undefined, appendModelIssue: true },
        );
      }
      case 'cancelled':
        return this.buildDecision(context, 'abort_without_retry', failure, `Invocation cancelled for candidate ${candidate}: ${sanitized}`, { abort: true, appendModelIssue: false });
      case 'unknown':
        return this.buildDecision(context, 'cooldown_and_failover', failure, `Candidate ${candidate} failed: ${sanitized}`, {
          markFailed: true,
          availability: { state: 'COOLING', untilMs: Date.now() + Math.max(context.recoveryDelayMs, 5_000), reason: 'unknown' },
          appendModelIssue: true,
        });
      default:
        return assertNever(failure);
    }
  }

  decideNoCandidates(context: InvocationRecoveryContext): InvocationRecoveryDecision {
    const capabilitySkips = context.capabilitySkips ?? [];
    const capabilityOnly = capabilitySkips.length > 0;
    const reasons = Array.from(new Set(capabilitySkips.flatMap((skip) => skip.reasons))).sort();
    const message = capabilityOnly
      ? `No capability-compatible candidates available for role '${context.role}'. Skipped reasons: ${reasons.join(', ') || 'unknown'}.`
      : `No healthy candidates available for role '${context.role}'.`;
    const synthetic: LlmTransportFailure = capabilityOnly
      ? {
          kind: 'capability_mismatch',
          provider: context.candidate?.provider ?? 'unknown',
          model: context.candidate?.model ?? 'unknown',
          requested: reasons,
          supported: [],
          message,
        }
      : { kind: 'unknown', provider: context.candidate?.provider ?? 'unknown', message };
    return this.buildDecision(
      context,
      'abort_without_retry',
      synthetic,
      message,
      { abort: true, appendModelIssue: false, capabilitySkipReasons: reasons },
    );
  }

  private buildDecision(
    context: InvocationRecoveryContext,
    action: InvocationRecoveryAction,
    failure: LlmTransportFailure | undefined,
    message: string,
    overrides: Partial<InvocationRecoveryDecision> = {},
  ): InvocationRecoveryDecision {
    const capabilitySkipReasons = overrides.capabilitySkipReasons ?? Array.from(new Set((context.capabilitySkips ?? []).flatMap((skip) => skip.reasons))).sort();
    const sanitizedFailure: LlmTransportFailure | undefined = failure ? { ...failure, message: sanitizeRecoveryMessage(failure.message) } : undefined;
    const eventPayload: Record<string, unknown> = {
      session_id: context.sessionId,
      role: context.role,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts,
      provider: context.candidate?.provider,
      model: context.candidate?.model,
      account: context.candidate?.account ?? undefined,
      failure: sanitizedFailure,
      recoveryAction: action,
      retryDelayMs: overrides.retryDelayMs,
      availability: overrides.availability,
      capabilitySkipReasons,
      error_message: sanitizeRecoveryMessage(message),
    };
    for (const key of Object.keys(eventPayload)) {
      const v = eventPayload[key];
      if (v === undefined || (Array.isArray(v) && v.length === 0)) delete eventPayload[key];
    }
    return {
      action,
      failure: sanitizedFailure,
      message: sanitizeRecoveryMessage(message),
      eventPayload,
      availability: overrides.availability,
      retryDelayMs: overrides.retryDelayMs,
      markFailed: overrides.markFailed ?? false,
      markSucceeded: overrides.markSucceeded ?? false,
      appendModelIssue: overrides.appendModelIssue ?? false,
      abort: overrides.abort ?? false,
    };
  }
}

export const defaultInvocationRecoveryPolicy = new InvocationRecoveryPolicy();
