import { randomUUID } from 'node:crypto';
import {
  ConversationSessionIdSchema,
  conversationSessionIdentity,
  sha256Hex,
} from '../schemas/index.js';
import {
  throwIfPublicationOutcomeUnknown,
  type OutboundObservationSource,
  type OutboundHttpObservation,
  type OutboundHttpEmitter,
  type OutboundHttpEvent,
  type OutboundHttpOutcome,
  type OutboundHttpCode,
  type OutboundBodyDisposition,
} from '../contracts/index.js';

// Configured labels are content, even when syntactically valid. Never echo them.
export function outboundIdentityReference(value: string): string {
  return `sha256:${sha256Hex(value)}`;
}
export function outboundSessionReference(value: string): string | undefined {
  // This code-owned synthetic invocation identity is already a non-content hash.
  if (/^internal:compaction-summary:[0-9a-f]{64}$/u.test(value)) return value;
  const parsed = ConversationSessionIdSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const identity = conversationSessionIdentity(parsed.data);
  return `agent:${outboundIdentityReference(identity.agentName)}:${identity.cardId ?? 'global'}`;
}
export function projectOutboundSource(
  sessionId: string | null,
  inputId: string,
): OutboundObservationSource {
  const parsed = ConversationSessionIdSchema.safeParse(sessionId);
  const card = parsed.success ? conversationSessionIdentity(parsed.data).cardId : null;
  return {
    source_session: sessionId === null ? undefined : outboundSessionReference(sessionId),
    ...(card ? { source_card: card } : {}),
    ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(inputId)
      ? { input_id: inputId }
      : {}),
  };
}
export function emitOutboundHttp(
  emitter: OutboundHttpEmitter | undefined,
  event: OutboundHttpEvent,
): void {
  try {
    emitter?.(event);
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
  }
}

/** One call-local observation; the owner retains all transport and parsing decisions. */
export function beginOutboundHttp(observation: OutboundHttpObservation) {
  const requestId = randomUUID();
  const started = performance.now();
  let status: number | undefined;
  let disposition: OutboundBodyDisposition = 'incomplete';
  emitOutboundHttp(observation.emitter, {
    ...observation.context,
    event: 'outbound_http_dispatch',
    request_id: requestId,
  });
  return {
    headers(response: Response) {
      status = response.status;
      emitOutboundHttp(observation.emitter, {
        ...observation.context,
        event: 'outbound_http_headers',
        request_id: requestId,
        status,
        elapsed_ms: performance.now() - started,
      });
    },
    body(value: OutboundBodyDisposition) {
      disposition = value;
    },
    terminal(outcome: OutboundHttpOutcome, code: OutboundHttpCode) {
      emitOutboundHttp(observation.emitter, {
        ...observation.context,
        event: 'outbound_http_terminal',
        request_id: requestId,
        status,
        elapsed_ms: performance.now() - started,
        outcome,
        error_code: code,
        body_disposition: disposition,
      });
      observation.onFinished?.(requestId);
    },
  };
}
