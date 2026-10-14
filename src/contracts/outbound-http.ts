/** Process observations only; never canonical persistence or transport authority. */
export interface OutboundObservationSource {
  readonly source_session?: string;
  readonly source_card?: string;
  readonly input_id?: string;
}
export interface OutboundHttpContext extends OutboundObservationSource {
  readonly service: 'provider' | 'auth' | 'mcp' | 'web';
  readonly purpose:
    | 'primary'
    | 'internal-summary'
    | 'auth-refresh'
    | 'mcp-startup'
    | 'mcp-initialize'
    | 'mcp-notification'
    | 'mcp-list'
    | 'mcp-invoke'
    | 'mcp-health'
    | 'websearch'
    | 'webfetch';
  readonly endpoint:
    | 'provider.responses'
    | 'provider.codex'
    | 'provider.chat'
    | 'provider.route'
    | 'auth.codex-token'
    | 'auth.copilot-token'
    | 'mcp.remote'
    | 'web.public'
    | 'web.search';
  readonly method: 'GET' | 'POST' | 'HEAD';
  readonly invocation_session?: string;
  readonly model_ref?: string;
  readonly attempt_index?: number;
}
export type OutboundHttpOutcome = 'completed' | 'http_error' | 'failed' | 'cancelled' | 'timeout';
export type OutboundHttpCode =
  | 'none'
  | 'network'
  | 'http_status'
  | 'protocol'
  | 'provider_failure'
  | 'inactivity'
  | 'deadline'
  | 'owner_abort'
  | 'body_limit'
  | 'unknown';
export type OutboundBodyDisposition =
  | 'consumed'
  | 'not_consumed'
  | 'cancelled_by_policy'
  | 'incomplete';
type RequestEvent = OutboundHttpContext & { readonly request_id: string };
export type OutboundHttpEvent =
  | (RequestEvent & { readonly event: 'outbound_http_dispatch' })
  | (RequestEvent & {
      readonly event: 'outbound_http_headers';
      readonly status: number;
      readonly elapsed_ms: number;
    })
  | (RequestEvent & {
      readonly event: 'outbound_http_terminal';
      readonly status?: number;
      readonly elapsed_ms: number;
      readonly outcome: OutboundHttpOutcome;
      readonly error_code: OutboundHttpCode;
      readonly body_disposition: OutboundBodyDisposition;
    })
  | (OutboundHttpContext & {
      readonly event: 'outbound_http_retry_wait';
      readonly request_id?: string;
      readonly retry_reason: 'standard' | 'overload' | 'rate_limit' | 'availability';
      readonly delay_ms: number;
      readonly deadline_ms?: number;
      readonly waiting_candidate_ref?: string;
    });
export type OutboundHttpEmitter = (event: OutboundHttpEvent) => void;
export interface OutboundHttpObservation {
  readonly emitter?: OutboundHttpEmitter;
  readonly context: OutboundHttpContext;
  readonly onFinished?: (requestId: string) => void;
}
