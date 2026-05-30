import type { AgentRole } from '../schemas/index.js';
import { unwrapFailure } from './llm-errors.js';
import type { LlmFailure } from './llm-failure.js';
import type { Candidate } from './provider.js';
import type { AvailabilityDecision } from './candidate-availability.js';
import type { CapabilityRequest, CapabilitySkipDiagnostic } from './provider-capabilities.js';

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
  failure?: LlmFailure;
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

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{8,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=:-]{8,}/gi,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
];

function candidateLabel(candidate?: Candidate): string {
  if (!candidate) return 'no-candidate';
  return `${candidate.provider}/${candidate.account ?? '_'}/${candidate.model}`;
}

export function sanitizeRecoveryMessage(value: unknown, maxLength = 500): string {
  let text = value instanceof Error ? value.message : String(value ?? 'Unknown error');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix) => {
      if (typeof prefix === 'string' && /Bearer\s+/i.test(prefix)) return `${prefix}[REDACTED]`;
      if (typeof prefix === 'string' && /api|token|secret|password/i.test(prefix)) return `${prefix}=[REDACTED]`;
      return '[REDACTED]';
    });
  }
  if (text.length > maxLength) return `${text.slice(0, maxLength)}…`;
  return text;
}

function assertNever(x: never): never {
  throw new Error('Unhandled failure kind: ' + JSON.stringify(x));
}

export class InvocationRecoveryPolicy {
  classify(error: unknown): LlmFailure {
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
        return this.buildDecision(context, 'failover_without_cooldown', failure, `Candidate ${candidate} failed with permanent auth error: ${sanitized}`, {
          markFailed: true,
          availability: { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 3_600_000, reason: 'auth_permanent' },
          appendModelIssue: true,
        });
      case 'capability_mismatch':
        return this.buildDecision(context, 'failover_without_cooldown', failure, `Candidate ${candidate} is incompatible with requested capabilities: ${sanitized}`, { appendModelIssue: true });
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
      case 'contract_mismatch':
        return this.buildDecision(context, 'fail_invocation', failure, `Candidate ${candidate} violated tool-call contract (subtype=${failure.subtype}): ${sanitized}`, { markFailed: false, appendModelIssue: true, abort: true });
      case 'token_budget_exceeded':
        return this.buildDecision(context, 'failover_without_cooldown', failure, `Candidate ${candidate} exceeded token budget: ${sanitized}`, { appendModelIssue: true });
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
    const synthetic: LlmFailure = capabilityOnly
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
    failure: LlmFailure | undefined,
    message: string,
    overrides: Partial<InvocationRecoveryDecision> = {},
  ): InvocationRecoveryDecision {
    const capabilitySkipReasons = overrides.capabilitySkipReasons ?? Array.from(new Set((context.capabilitySkips ?? []).flatMap((skip) => skip.reasons))).sort();
    const sanitizedFailure: LlmFailure | undefined = failure ? { ...failure, message: sanitizeRecoveryMessage(failure.message) } : undefined;
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
