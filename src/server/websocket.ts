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
import { AnalystHandler, getOrCreateAnalystSession } from '../agents/analyst-handler.js';

// ── Types ─────────────────────────────────────────────────────

export type WsEventType = 'message' | 'activity' | 'thinking' | 'status' | 'error';

export interface WsEnvelope {
  type: WsEventType;
  content: Record<string, unknown>;
}

// ── Analyst Handler (lazy singleton) ──────────────────────────

let _analystHandler: AnalystHandler | null = null;

function getAnalystHandler(projectRoot: string): AnalystHandler {
  if (!_analystHandler) {
    _analystHandler = new AnalystHandler(projectRoot, (activity) => {
      broadcast({ type: 'activity', content: activity as Record<string, unknown> });
    });
  }
  return _analystHandler;
}

// ── Client Tracking ───────────────────────────────────────────

const clients = new Set<WebSocket>();

/** Map each WebSocket connection to its analyst session ID. */
const wsSessions = new WeakMap<WebSocket, string>();

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
  if (!token) {
    // No token configured — development mode.
    // Server startup (validateDevModeHost in server.ts) ensures that
    // only localhost binds are allowed in this mode, so this pass-through
    // is safe: external connections cannot reach the server without auth
    // because the server refuses to bind to non-local addresses.
    return true;
  }

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

export function registerWebSocket(fastify: FastifyInstance, projectRoot: string): void {
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

      // Auto-create analyst session for this connection
      const { sessionId } = getOrCreateAnalystSession(projectRoot);
      wsSessions.set(ws, sessionId);

      // Send welcome message with session info
      sendToClient(ws, {
        type: 'status',
        content: {
          event: 'connected',
          sessionId,
          timestamp: new Date().toISOString(),
          clientCount: clients.size,
        },
      });

      // Handle incoming messages (client → server)
      ws.on('message', async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const data =
            typeof raw === 'string'
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString('utf-8')
                : Buffer.concat(raw as Buffer[]).toString('utf-8');
          const parsed = JSON.parse(data) as { type?: string; content?: Record<string, unknown> };

          if (parsed.type === 'message' && parsed.content?.text) {
            // Get or re-create session for this connection
            let currentSessionId = wsSessions.get(ws);
            if (!currentSessionId) {
              const { sessionId: newId } = getOrCreateAnalystSession(projectRoot);
              currentSessionId = newId;
              wsSessions.set(ws, currentSessionId);
            }

            // Route through the analyst handler
            const handler = getAnalystHandler(projectRoot);
            const response = await handler.handleMessage(
              currentSessionId,
              String(parsed.content.text),
            );

            // Send the analyst response back
            sendToClient(ws, {
              type: 'message',
              content: response.message as Record<string, unknown>,
            });

            // Also send any tool invocations as activity events
            if (response.toolInvocations) {
              for (const inv of response.toolInvocations) {
                sendToClient(ws, {
                  type: 'activity',
                  content: {
                    event: 'tool_invocation',
                    tool: inv.tool,
                    params: inv.params,
                    result: inv.result,
                  },
                });
              }
            }
          }
        } catch (err) {
          sendToClient(ws, {
            type: 'error',
            content: {
              error: 'Failed to process message',
              details: err instanceof Error ? err.message : String(err),
            },
          });
        }
      });

      ws.on('close', () => {
        clients.delete(ws);
        wsSessions.delete(ws);
      });

      ws.on('error', () => {
        clients.delete(ws);
        wsSessions.delete(ws);
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
    'session_started', 'model_selected',
    'invocation_succeeded', 'invocation_failed',
    'retry_attempted', 'compaction_triggered',
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
