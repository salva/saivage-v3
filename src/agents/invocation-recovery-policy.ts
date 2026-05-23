import type { AgentRole } from '../schemas/index.js';
import {
  LlmAuthError,
  LlmParseError,
  LlmRateLimitError,
  LlmServerError,
  LlmTimeoutError,
} from './llm-client.js';
import type { Candidate } from './provider.js';
import type { CapabilityRequest, CapabilitySkipDiagnostic } from './provider-capabilities.js';

export type InvocationFailureClass =
  | 'capability_mismatch'
  | 'auth_permanent'
  | 'rate_limit_transient'
  | 'server_transient'
  | 'timeout_transient'
  | 'parse_or_contract'
  | 'cancelled'
  | 'unknown';

export type InvocationRecoveryAction =
  | 'mark_succeeded'
  | 'cooldown_and_failover'
  | 'failover_without_cooldown'
  | 'retry_same_after_delay'
  | 'abort_without_retry';

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
  failureClass?: InvocationFailureClass;
  message: string;
  eventPayload: Record<string, unknown>;
  cooldownMs?: number;
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

function isAbortLike(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (!(error instanceof Error)) return false;
  return /\bcancell?ed\b|\babort(?:ed)?\b/i.test(error.message) || error.name === 'AbortError';
}

function isCapabilityMismatch(error: unknown, context: InvocationRecoveryContext): boolean {
  if ((context.capabilitySkips?.length ?? 0) > 0) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/does not support requested LLM capabilities|unsupported_/i.test(message)) return true;
  }
  if (!(error instanceof Error)) return false;
  return /does not support requested LLM capabilities|unsupported_(?:tool_calls|tool_choice|transport_protocol|response_shape|streaming)/i.test(error.message);
}

export class InvocationRecoveryPolicy {
  classify(error: unknown, context: InvocationRecoveryContext): InvocationFailureClass {
    if (isAbortLike(error)) return 'cancelled';
    if (isCapabilityMismatch(error, context)) return 'capability_mismatch';
    if (error instanceof LlmAuthError) return 'auth_permanent';
    if (error instanceof LlmRateLimitError) return 'rate_limit_transient';
    if (error instanceof LlmServerError) return 'server_transient';
    if (error instanceof LlmTimeoutError) return 'timeout_transient';
    if (error instanceof LlmParseError) return 'parse_or_contract';
    if (error instanceof SyntaxError || error instanceof TypeError || (error instanceof Error && /parse|schema|contract|validation failed|invalid .*json/i.test(error.message))) return 'parse_or_contract';
    return 'unknown';
  }

  decideSuccess(context: InvocationRecoveryContext): InvocationRecoveryDecision {
    return this.buildDecision(context, 'mark_succeeded', undefined, `Candidate ${candidateLabel(context.candidate)} succeeded.`, {
      markSucceeded: true,
      appendModelIssue: false,
    });
  }

  decideFailure(error: unknown, context: InvocationRecoveryContext): InvocationRecoveryDecision {
    const failureClass = this.classify(error, context);
    const sanitized = sanitizeRecoveryMessage(error);
    const candidate = candidateLabel(context.candidate);

    switch (failureClass) {
      case 'auth_permanent':
        return this.buildDecision(context, 'failover_without_cooldown', failureClass, `Candidate ${candidate} failed with permanent auth error: ${sanitized}`, { appendModelIssue: true });
      case 'capability_mismatch':
        return this.buildDecision(context, 'failover_without_cooldown', failureClass, `Candidate ${candidate} is incompatible with requested capabilities: ${sanitized}`, { appendModelIssue: true });
      case 'rate_limit_transient':
      case 'server_transient':
      case 'timeout_transient':
        return this.buildDecision(context, 'cooldown_and_failover', failureClass, `Candidate ${candidate} failed transiently: ${sanitized}`, { markFailed: true, cooldownMs: context.recoveryDelayMs, appendModelIssue: true });
      case 'parse_or_contract': {
        const canRetrySame = context.attempt <= context.maxRecoveryRetries;
        return this.buildDecision(
          context,
          canRetrySame ? 'retry_same_after_delay' : 'failover_without_cooldown',
          failureClass,
          `Candidate ${candidate} produced an invalid response contract: ${sanitized}`,
          { retryDelayMs: canRetrySame ? context.recoveryDelayMs : undefined, appendModelIssue: true },
        );
      }
      case 'cancelled':
        return this.buildDecision(context, 'abort_without_retry', failureClass, `Invocation cancelled for candidate ${candidate}: ${sanitized}`, { abort: true, appendModelIssue: false });
      case 'unknown':
      default:
        return this.buildDecision(context, 'cooldown_and_failover', failureClass, `Candidate ${candidate} failed: ${sanitized}`, { markFailed: true, cooldownMs: context.recoveryDelayMs, appendModelIssue: true });
    }
  }

  decideNoCandidates(context: InvocationRecoveryContext): InvocationRecoveryDecision {
    const capabilitySkips = context.capabilitySkips ?? [];
    const capabilityOnly = capabilitySkips.length > 0;
    const reasons = Array.from(new Set(capabilitySkips.flatMap((skip) => skip.reasons))).sort();
    const message = capabilityOnly
      ? `No capability-compatible candidates available for role '${context.role}'. Skipped reasons: ${reasons.join(', ') || 'unknown'}.`
      : `No healthy candidates available for role '${context.role}'.`;
    return this.buildDecision(
      context,
      'abort_without_retry',
      capabilityOnly ? 'capability_mismatch' : 'unknown',
      message,
      { abort: true, appendModelIssue: false, capabilitySkipReasons: reasons },
    );
  }

  private buildDecision(
    context: InvocationRecoveryContext,
    action: InvocationRecoveryAction,
    failureClass: InvocationFailureClass | undefined,
    message: string,
    overrides: Partial<InvocationRecoveryDecision> = {},
  ): InvocationRecoveryDecision {
    const capabilitySkipReasons = overrides.capabilitySkipReasons ?? Array.from(new Set((context.capabilitySkips ?? []).flatMap((skip) => skip.reasons))).sort();
    const eventPayload: Record<string, unknown> = {
      session_id: context.sessionId,
      role: context.role,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts,
      provider: context.candidate?.provider,
      model: context.candidate?.model,
      account: context.candidate?.account ?? undefined,
      failureClass,
      recoveryAction: action,
      retryDelayMs: overrides.retryDelayMs,
      cooldownMs: overrides.cooldownMs,
      capabilitySkipReasons,
      error_message: sanitizeRecoveryMessage(message),
    };
    for (const key of Object.keys(eventPayload)) {
      if (eventPayload[key] === undefined || (Array.isArray(eventPayload[key]) && eventPayload[key].length === 0)) delete eventPayload[key];
    }
    return {
      action,
      failureClass,
      message: sanitizeRecoveryMessage(message),
      eventPayload,
      cooldownMs: overrides.cooldownMs,
      retryDelayMs: overrides.retryDelayMs,
      markFailed: overrides.markFailed ?? false,
      markSucceeded: overrides.markSucceeded ?? false,
      appendModelIssue: overrides.appendModelIssue ?? false,
      abort: overrides.abort ?? false,
    };
  }
}

export const defaultInvocationRecoveryPolicy = new InvocationRecoveryPolicy();
