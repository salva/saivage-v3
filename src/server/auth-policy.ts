import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export interface AuthPolicyOptions {
  apiToken?: string;
  wsTicketTtlMs?: number;
  now?: () => number;
  randomBytes?: (bytes: number) => Buffer;
}

export type HttpAuthResult =
  | { ok: true; mode: 'disabled' | 'bearer' }
  | { ok: false; statusCode: 401; reason: 'missing' | 'malformed' | 'invalid' | 'query-token-prohibited' };

export type WebSocketAuthResult =
  | { ok: true; mode: 'disabled' | 'ticket' }
  | { ok: false; closeCode: 1008; reason: 'missing' | 'invalid' | 'expired' | 'used' | 'api-token-prohibited' };

export interface IssuedWebSocketTicket {
  ticket: string;
  expiresAt: string;
}

interface StoredTicket {
  expiresAtMs: number;
  used: boolean;
}

const DEFAULT_WS_TICKET_TTL_MS = 30_000;

function configuredApiToken(explicit?: string): string | undefined {
  return explicit ?? process.env['SAIVAGE_API_TOKEN'];
}

function hasQueryCredential(query: unknown): boolean {
  if (!query || typeof query !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(query as Record<string, unknown>, 'token');
}

function safeTokenEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseBearer(authHeader: unknown): { ok: true; token: string } | { ok: false; malformed: boolean } {
  if (typeof authHeader !== 'string' || authHeader.trim() === '') {
    return { ok: false, malformed: false };
  }
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
    return { ok: false, malformed: true };
  }
  return { ok: true, token: parts[1] };
}

export class AuthPolicy {
  private readonly apiToken?: string;
  private readonly wsTicketTtlMs: number;
  private readonly now: () => number;
  private readonly randomBytes: (bytes: number) => Buffer;
  private readonly tickets = new Map<string, StoredTicket>();

  constructor(options: AuthPolicyOptions = {}) {
    this.apiToken = configuredApiToken(options.apiToken);
    this.wsTicketTtlMs = options.wsTicketTtlMs ?? DEFAULT_WS_TICKET_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  get authEnabled(): boolean {
    return Boolean(this.apiToken);
  }

  validateHttpRequest(request: Pick<FastifyRequest, 'headers' | 'query'>): HttpAuthResult {
    if (!this.apiToken) {
      return { ok: true, mode: 'disabled' };
    }

    if (hasQueryCredential(request.query)) {
      return { ok: false, statusCode: 401, reason: 'query-token-prohibited' };
    }

    const parsed = parseBearer(request.headers.authorization);
    if (!parsed.ok) {
      return { ok: false, statusCode: 401, reason: parsed.malformed ? 'malformed' : 'missing' };
    }

    if (!safeTokenEquals(parsed.token, this.apiToken)) {
      return { ok: false, statusCode: 401, reason: 'invalid' };
    }

    return { ok: true, mode: 'bearer' };
  }

  issueWebSocketTicket(): IssuedWebSocketTicket {
    this.cleanupExpiredTickets();
    const ticket = `wst_${this.randomBytes(32).toString('base64url')}`;
    const expiresAtMs = this.now() + this.wsTicketTtlMs;
    this.tickets.set(ticket, { expiresAtMs, used: false });
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  validateWebSocketRequest(request: Pick<FastifyRequest, 'query'>): WebSocketAuthResult {
    if (!this.apiToken) {
      return { ok: true, mode: 'disabled' };
    }

    const query = (request.query ?? {}) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(query, 'token')) {
      return { ok: false, closeCode: 1008, reason: 'api-token-prohibited' };
    }

    const ticket = query['ticket'];
    if (typeof ticket !== 'string' || ticket.length === 0) {
      return { ok: false, closeCode: 1008, reason: 'missing' };
    }

    const stored = this.tickets.get(ticket);
    if (!stored) {
      return { ok: false, closeCode: 1008, reason: 'invalid' };
    }
    if (stored.used) {
      this.tickets.delete(ticket);
      return { ok: false, closeCode: 1008, reason: 'used' };
    }
    if (stored.expiresAtMs <= this.now()) {
      this.tickets.delete(ticket);
      return { ok: false, closeCode: 1008, reason: 'expired' };
    }

    stored.used = true;
    return { ok: true, mode: 'ticket' };
  }

  clearTickets(): void {
    this.tickets.clear();
  }

  private cleanupExpiredTickets(): void {
    const now = this.now();
    for (const [ticket, stored] of this.tickets.entries()) {
      if (stored.expiresAtMs <= now || stored.used) {
        this.tickets.delete(ticket);
      }
    }
  }
}

let defaultPolicy: AuthPolicy | undefined;
let defaultToken: string | undefined;

export function getAuthPolicy(): AuthPolicy {
  const token = process.env['SAIVAGE_API_TOKEN'];
  if (!defaultPolicy || defaultToken !== token) {
    defaultPolicy = new AuthPolicy({ apiToken: token });
    defaultToken = token;
  }
  return defaultPolicy;
}

export function resetAuthPolicyForTests(): void {
  defaultPolicy = undefined;
  defaultToken = undefined;
}
