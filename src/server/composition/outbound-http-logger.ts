import type { FastifyBaseLogger } from 'fastify';
import type { OutboundHttpEmitter } from '../../contracts/index.js';

export function bindOutboundHttpLogger(logger: FastifyBaseLogger): OutboundHttpEmitter {
  return (event) => {
    // Closed projection only: no request/config/error/header objects reach this sink.
    logger.info(
      {
        event: event.event,
        request_id: event.request_id,
        service: event.service,
        purpose: event.purpose,
        endpoint: event.endpoint,
        method: event.method,
        source_session: event.source_session,
        source_card: event.source_card,
        input_id: event.input_id,
        invocation_session: event.invocation_session,
        model_ref: event.model_ref,
        attempt_index: event.attempt_index,
        status: 'status' in event ? event.status : undefined,
        elapsed_ms: 'elapsed_ms' in event ? event.elapsed_ms : undefined,
        outcome: event.event === 'outbound_http_terminal' ? event.outcome : undefined,
        error_code: event.event === 'outbound_http_terminal' ? event.error_code : undefined,
        body_disposition:
          event.event === 'outbound_http_terminal' ? event.body_disposition : undefined,
        retry_reason: event.event === 'outbound_http_retry_wait' ? event.retry_reason : undefined,
        delay_ms: event.event === 'outbound_http_retry_wait' ? event.delay_ms : undefined,
        deadline_ms: event.event === 'outbound_http_retry_wait' ? event.deadline_ms : undefined,
        waiting_candidate_ref:
          event.event === 'outbound_http_retry_wait' ? event.waiting_candidate_ref : undefined,
      },
      'Outbound HTTP lifecycle',
    );
  };
}
