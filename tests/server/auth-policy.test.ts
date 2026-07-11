import { describe, expect, it } from '@jest/globals';
import { AuthPolicy } from '../../src/server/auth-policy.js';

const TOKEN = 'arch004-test-token';

function request(headers: Record<string, string> = {}, query: Record<string, unknown> = {}) {
  return { headers, query } as any;
}

describe('AuthPolicy', () => {
  it('preserves auth-disabled behavior for HTTP and WebSocket paths', () => {
    const policy = new AuthPolicy({ apiToken: undefined });
    expect(policy.validateHttpRequest(request()).ok).toBe(true);
    expect(policy.validateWebSocketRequest(request()).ok).toBe(true);
  });

  it('accepts exact bearer auth and rejects missing, malformed, and invalid headers', () => {
    const policy = new AuthPolicy({ apiToken: TOKEN });
    expect(policy.validateHttpRequest(request({ authorization: `Bearer ${TOKEN}` }))).toEqual({ ok: true, mode: 'bearer' });
    expect(policy.validateHttpRequest(request())).toMatchObject({ ok: false, reason: 'missing' });
    expect(policy.validateHttpRequest(request({ authorization: TOKEN }))).toMatchObject({ ok: false, reason: 'malformed' });
    expect(policy.validateHttpRequest(request({ authorization: 'Bearer arch004-invalid-token' }))).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects query token credentials even when a valid bearer header is present', () => {
    const policy = new AuthPolicy({ apiToken: TOKEN });
    expect(policy.validateHttpRequest(request({ authorization: `Bearer ${TOKEN}` }, { token: TOKEN }))).toMatchObject({
      ok: false,
      reason: 'query-token-prohibited',
    });
  });

  it('issues deterministic opaque tickets and consumes each ticket once', () => {
    let now = 1_700_000_000_000;
    const policy = new AuthPolicy({
      apiToken: TOKEN,
      wsTicketTtlMs: 1000,
      now: () => now,
      randomBytes: (bytes) => Buffer.alloc(bytes, 7),
    });

    const issued = policy.issueWebSocketTicket();
    expect(issued.ticket).toMatch(/^wst_/);
    expect(issued.ticket).not.toContain(TOKEN);
    expect(issued.expiresAt).toBe(new Date(now + 1000).toISOString());
    expect(policy.validateWebSocketRequest(request({}, { ticket: issued.ticket }))).toEqual({ ok: true, mode: 'ticket' });
    expect(policy.validateWebSocketRequest(request({}, { ticket: issued.ticket }))).toMatchObject({ ok: false, reason: 'used' });
  });

  it('keeps tickets isolated between server-local policy instances', () => {
    const first = new AuthPolicy({ apiToken: TOKEN });
    const second = new AuthPolicy({ apiToken: TOKEN });
    const ticket = first.issueWebSocketTicket().ticket;

    expect(second.validateWebSocketRequest(request({}, { ticket }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(first.validateWebSocketRequest(request({}, { ticket }))).toEqual({ ok: true, mode: 'ticket' });
  });

  it('rejects missing, invalid, expired, and API-token query WebSocket credentials', () => {
    let now = 10_000;
    const policy = new AuthPolicy({
      apiToken: TOKEN,
      wsTicketTtlMs: 5,
      now: () => now,
      randomBytes: (bytes) => Buffer.alloc(bytes, 3),
    });
    const issued = policy.issueWebSocketTicket();

    expect(policy.validateWebSocketRequest(request())).toMatchObject({ ok: false, closeCode: 1008, reason: 'missing' });
    expect(policy.validateWebSocketRequest(request({}, { ticket: 'arch004-ticket-invalid' }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(policy.validateWebSocketRequest(request({}, { token: TOKEN }))).toMatchObject({ ok: false, reason: 'api-token-prohibited' });

    now += 6;
    expect(policy.validateWebSocketRequest(request({}, { ticket: issued.ticket }))).toMatchObject({ ok: false, reason: 'expired' });
  });
});
