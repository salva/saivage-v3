/**
 * WebSocket endpoint and event bus wiring.
 *
 * Connection:  ws://host:port/ws
 * Auth:        Checked on upgrade; invalid → close 1008.
 *
 * Message envelope (JSON):
 *   { "type": "message | activity | thinking | status | error", "content": { ... } }
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

// ── Types ─────────────────────────────────────────────────────

export type WsEventType = 'message' | 'activity' | 'thinking' | 'status' | 'error';

export interface WsEnvelope {
  type: WsEventType;
  content: Record<string, unknown>;
}

// ── Client Tracking ───────────────────────────────────────────

const clients = new Set<WebSocket>();

export function broadcast(event: WsEnvelope): void {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    } catch {
      // Silently drop dead clients
    }
  }
}

export function sendToClient(ws: WebSocket, event: WsEnvelope): void {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  } catch {
    // Silently drop
  }
}

export function getClientCount(): number {
  return clients.size;
}

// ── Auth Check Helper ─────────────────────────────────────────

function getApiToken(): string | undefined {
  return process.env['SAIVAGE_API_TOKEN'];
}

function checkAuth(request: FastifyRequest): boolean {
  const token = getApiToken();
  if (!token) return true; // No token configured → auth disabled

  // Check Authorization: Bearer <token>
  const authHeader = request.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      if (parts[1] === token) return true;
    }
  }

  // Check ?token= query parameter
  const queryToken = (request.query as Record<string, string> | undefined)?.['token'];
  if (queryToken === token) return true;

  return false;
}

// ── WebSocket Registration ────────────────────────────────────

export function registerWebSocket(fastify: FastifyInstance): void {
  fastify.get(
    '/ws',
    { websocket: true },
    (ws: WebSocket, request: FastifyRequest) => {
      // Auth check — if fails, close with 1008
      if (!checkAuth(request)) {
        ws.close(1008, 'Authentication failed');
        return;
      }

      // Connection accepted
      clients.add(ws);

      // Send welcome message
      sendToClient(ws, {
        type: 'status',
        content: {
          event: 'connected',
          timestamp: new Date().toISOString(),
          clientCount: clients.size,
        },
      });

      // Handle incoming messages (client → server)
      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const data = typeof raw === 'string'
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString('utf-8')
              : Buffer.concat(raw as Buffer[]).toString('utf-8');
          const parsed = JSON.parse(data) as WsEnvelope;

          if (parsed.type === 'message') {
            sendToClient(ws, {
              type: 'message',
              content: {
                role: 'system',
                text: 'Message received. Analyst routing is not yet implemented.',
                timestamp: new Date().toISOString(),
              },
            });
          }
        } catch {
          sendToClient(ws, {
            type: 'error',
            content: {
              error: 'Invalid message format',
              details: 'Messages must be valid JSON with a "type" field.',
            },
          });
        }
      });

      ws.on('close', () => {
        clients.delete(ws);
      });

      ws.on('error', () => {
        clients.delete(ws);
      });
    },
  );
}

// ── Event Bus Integration Helpers ─────────────────────────────

export function createRuntimeEnvelope(
  eventName: string,
  data: Record<string, unknown>,
): WsEnvelope {
  switch (eventName) {
    case 'goal_completed':
      return { type: 'status', content: { event: eventName, ...data } };
    case 'goal_failed':
      return { type: 'error', content: { event: eventName, ...data } };
    case 'escalation':
      return { type: 'status', content: { event: eventName, ...data } };
    case 'card_failed':
      return { type: 'error', content: { event: eventName, ...data } };
    case 'review_complete':
      return { type: 'status', content: { event: eventName, ...data } };
    case 'plan_updated':
      return { type: 'activity', content: { event: eventName, ...data } };
    default:
      return { type: 'status', content: { event: eventName, ...data } };
  }
}

export function wireRuntimeEvents(runtime: {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}): void {
  const trackedEvents = [
    'started', 'shutdown', 'paused', 'resumed',
    'goal_completed', 'goal_failed', 'escalation',
    'card_failed', 'review_complete', 'plan_updated',
    'error', 'dispatch_blocked',
  ];

  for (const eventName of trackedEvents) {
    runtime.on(eventName, (data: unknown) => {
      const payload = data && typeof data === 'object'
        ? (data as Record<string, unknown>)
        : { raw: data };
      const envelope = createRuntimeEnvelope(eventName, payload);
      broadcast(envelope);
    });
  }
}
