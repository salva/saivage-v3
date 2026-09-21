import { isPromptPolicyRejection, unwrapFailure } from '../contracts/llm-failure.js';
import type { LlmTransportFailure } from '../contracts/llm-failure.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import type { AvailabilityDecision } from './candidate-availability.js';

interface InvocationFailureContext {
  candidate: Candidate;
  recoveryDelayMs: number;
  purpose: 'primary' | 'internal-summary';
  promptPolicyRejections: number;
}

type InvocationFailureDecision =
  | { kind: 'terminal'; availability?: AvailabilityDecision }
  | { kind: 'retry'; wait: 'rate-limit'; availability: AvailabilityDecision }
  | { kind: 'retry'; wait: 'standard'; retryDelayMs: number; availability?: AvailabilityDecision };

function assertNever(x: never): never {
  throw new Error('Unhandled failure kind: ' + JSON.stringify(x));
}

class InvocationRecoveryPolicy {
  private classify(error: unknown): LlmTransportFailure {
    const failure = unwrapFailure(error);
    if (failure.kind === 'unknown' && error instanceof Error && (error.name === 'ZodError' || error.name === 'SyntaxError')) {
      return { kind: 'parse_error', provider: failure.provider, message: failure.message };
    }
    return failure;
  }

  decideFailure(error: unknown, context: InvocationFailureContext): InvocationFailureDecision {
    const failure = this.classify(error);

    if (context.purpose === 'internal-summary' && context.promptPolicyRejections === 0 && isPromptPolicyRejection(error))
      return { kind: 'retry', wait: 'standard', retryDelayMs: 0 };

    switch (failure.kind) {
      case 'auth_permanent':
        return {
          kind: 'terminal',
          availability: { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 3_600_000, reason: 'auth_permanent' },
        };
      case 'capability_mismatch':
        return { kind: 'terminal' };
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
        return {
          kind: 'retry',
          wait: 'rate-limit',
          availability: { state: 'BLOCKED_UNTIL', untilMs, reason: 'rate_limit' },
        };
      }
      case 'server_transient':
      case 'timeout':
        return {
          kind: 'retry',
          wait: 'standard',
          retryDelayMs: context.recoveryDelayMs,
          availability: { state: 'COOLING', untilMs: Date.now() + Math.max(context.recoveryDelayMs, 5_000), reason: failure.kind },
        };
      case 'provider_protocol_error':
      case 'content_policy':
      case 'input_context_exhausted':
      case 'output_token_limit_exceeded':
      case 'local_setup_error':
        return { kind: 'terminal' };
      case 'parse_error':
        return { kind: 'retry', wait: 'standard', retryDelayMs: context.recoveryDelayMs };
      case 'cancelled':
        return { kind: 'terminal' };
      case 'unknown':
        return {
          kind: 'retry',
          wait: 'standard',
          retryDelayMs: context.recoveryDelayMs,
          availability: { state: 'COOLING', untilMs: Date.now() + Math.max(context.recoveryDelayMs, 5_000), reason: 'unknown' },
        };
      default:
        return assertNever(failure);
    }
  }
}

export const defaultInvocationRecoveryPolicy = new InvocationRecoveryPolicy();
