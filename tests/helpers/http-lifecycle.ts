import { expect } from '@jest/globals';
import type { OutboundHttpEvent } from '../../src/contracts/index.js';
import { bindOutboundHttpLogger } from '../../src/server/composition/outbound-http-logger.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function microtasks() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
export function capturedHttp() {
  const records: OutboundHttpEvent[] = [];
  // Capture what the logger serializes, not references that can change later.
  const sink = bindOutboundHttpLogger({ info(event: unknown) { records.push(JSON.parse(JSON.stringify(event))); } } as Parameters<typeof bindOutboundHttpLogger>[0]);
  return { records, sink };
}
export function assertPrivateMetadata(records: OutboundHttpEvent[], secrets: string[]) {
  const allowed = new Set(['event', 'request_id', 'service', 'purpose', 'endpoint', 'method',
    'source_session', 'source_card', 'input_id', 'invocation_session', 'model_ref', 'attempt_index',
    'status', 'elapsed_ms', 'outcome', 'error_code', 'body_disposition', 'retry_reason', 'delay_ms',
    'deadline_ms', 'waiting_candidate_ref']);
  const serialized = JSON.stringify(records);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
  for (const record of records) {
    for (const key of Object.keys(record)) expect(allowed.has(key)).toBe(true);
    expect(['provider', 'auth', 'mcp', 'web']).toContain(record.service);
    expect(['primary', 'internal-summary', 'auth-refresh', 'mcp-startup', 'mcp-initialize', 'mcp-notification', 'mcp-list', 'mcp-invoke', 'mcp-health', 'websearch', 'webfetch']).toContain(record.purpose);
    expect(['provider.responses', 'provider.codex', 'provider.chat', 'provider.route', 'auth.codex-token', 'auth.copilot-token', 'mcp.remote', 'web.public', 'web.search']).toContain(record.endpoint);
    expect(['GET', 'POST', 'HEAD']).toContain(record.method);
    if (record.event === 'outbound_http_terminal') {
      expect(['completed', 'http_error', 'failed', 'cancelled', 'timeout']).toContain(record.outcome);
      expect(['none', 'network', 'http_status', 'protocol', 'provider_failure', 'inactivity', 'deadline', 'owner_abort', 'body_limit', 'unknown']).toContain(record.error_code);
      expect(['consumed', 'not_consumed', 'cancelled_by_policy', 'incomplete']).toContain(record.body_disposition);
    }
  }
}
export function assertLifecycles(records: OutboundHttpEvent[], count: number) {
  const dispatches = records.filter(r => r.event === 'outbound_http_dispatch');
  expect(dispatches).toHaveLength(count);
  expect(new Set(dispatches.map(r => r.request_id)).size).toBe(count);
  for (const dispatch of dispatches) {
    const events = records.filter(r => 'request_id' in r && r.request_id === dispatch.request_id && r.event !== 'outbound_http_retry_wait');
    expect(events.map(r => r.event)).toEqual(['outbound_http_dispatch', 'outbound_http_headers', 'outbound_http_terminal']);
    for (const event of events) {
      expect(event).toMatchObject({ service: dispatch.service, purpose: dispatch.purpose, endpoint: dispatch.endpoint,
        ...(dispatch.source_session ? { source_session: dispatch.source_session } : {}),
        ...(dispatch.source_card ? { source_card: dispatch.source_card } : {}),
        ...(dispatch.input_id ? { input_id: dispatch.input_id } : {}) });
    }
    const headers = events[1]!; const terminal = events[2]!;
    if (headers.event !== 'outbound_http_headers' || terminal.event !== 'outbound_http_terminal') throw new Error('Expected HTTP phases');
    expect(headers.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(terminal.elapsed_ms).toBeGreaterThanOrEqual(headers.elapsed_ms);
  }
}
