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
import type { EventBus, EventBusSubscription } from '../utils/event-bus.js';
import type { LoggedEvent } from '../schemas/types.js';
import { redactOperatorErrorMessage } from '../utils/file-access-security.js';

export type WsEventType = 'message' | 'activity' | 'thinking' | 'status' | 'error';

export interface WsEnvelope {
  type: WsEventType;
  content: Record<string, unknown>;
}

const analystHandlersByRoot = new Map<string, AnalystHandler>();

function getAnalystHandler(projectRoot: string): AnalystHandler {
  let handler = analystHandlersByRoot.get(projectRoot);
  if (!handler) {
    handler = new AnalystHandler(projectRoot, (activity) => {
      broadcast({ type: 'activity', content: activity as Record<string, unknown> });
    });
    analystHandlersByRoot.set(projectRoot, handler);
  }
  return handler;
}

const clients = new Set<WebSocket>();
const wsSessions = new WeakMap<WebSocket, string>();
const runtimeEventSubscriptions = new Map<object, EventBusSubscription>();

export function resetWebSocketState(projectRoot?: string): void {
  for (const ws of clients) {
    try {
      ws.removeAllListeners();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close();
      }
    } catch {
    }
  }
  clients.clear();

  if (projectRoot) {
    analystHandlersByRoot.delete(projectRoot);
    return;
  }

  analystHandlersByRoot.clear();
}

export function resetRuntimeEventSubscriptions(runtime?: { eventBus: EventBus }): void {
  if (runtime) {
    const key = runtime.eventBus as object;
    const subscription = runtimeEventSubscriptions.get(key);
    if (subscription) {
      subscription.unsubscribe();
      runtimeEventSubscriptions.delete(key);
    }
    return;
  }

  for (const [key, subscription] of runtimeEventSubscriptions.entries()) {
    subscription.unsubscribe();
    runtimeEventSubscriptions.delete(key);
  }
}

export function broadcast(event: WsEnvelope): void {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    } catch {
    }
  }
}

export function sendToClient(ws: WebSocket, event: WsEnvelope): void {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  } catch {
  }
}

export function getClientCount(): number {
  return clients.size;
}

export function getRuntimeEventSubscriptionCount(): number {
  return runtimeEventSubscriptions.size;
}

function getApiToken(): string | undefined {
  return process.env['SAIVAGE_API_TOKEN'];
}

function checkAuth(request: FastifyRequest): boolean {
  const token = getApiToken();
  if (!token) {
    return true;
  }

  const authHeader = request.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      if (parts[1] === token) return true;
    }
  }

  const queryToken = (request.query as Record<string, string> | undefined)?.['token'];
  if (queryToken === token) return true;

  return false;
}

function rejectUnauthorizedWebSocket(ws: WebSocket): void {
  ws.close(1008, 'Authentication failed');

  const wsWithPrivateState = ws as WebSocket & {
    _closeTimer?: NodeJS.Timeout;
  };
  const closeTimer = wsWithPrivateState._closeTimer;
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer.unref();
    wsWithPrivateState._closeTimer = undefined;
  }
}

export function registerWebSocket(fastify: FastifyInstance, projectRoot: string): void {
  fastify.addHook('onClose', async () => {
    resetWebSocketState(projectRoot);
  });

  fastify.get(
    '/ws',
    { websocket: true },
    (ws: WebSocket, request: FastifyRequest) => {
      if (!checkAuth(request)) {
        rejectUnauthorizedWebSocket(ws);
        return;
      }

      clients.add(ws);

      const { sessionId } = getOrCreateAnalystSession(projectRoot);
      wsSessions.set(ws, sessionId);

      sendToClient(ws, {
        type: 'status',
        content: {
          event: 'connected',
          sessionId,
          timestamp: new Date().toISOString(),
          clientCount: clients.size,
        },
      });

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
            let currentSessionId = wsSessions.get(ws);
            if (!currentSessionId) {
              const { sessionId: newId } = getOrCreateAnalystSession(projectRoot);
              currentSessionId = newId;
              wsSessions.set(ws, currentSessionId);
            }

            const handler = getAnalystHandler(projectRoot);
            const response = await handler.handleMessage(
              currentSessionId,
              String(parsed.content.text),
            );

            sendToClient(ws, {
              type: 'message',
              content: response.message as Record<string, unknown>,
            });

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
              details: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot),
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
  eventBus: EventBus;
}): void {
  const eventBusRef = runtime.eventBus as object;
  if (runtimeEventSubscriptions.has(eventBusRef)) {
    return;
  }

  const subscription = runtime.eventBus.subscribe({
    minSeverity: 'info',
    handler: (event: LoggedEvent) => {
      const { kind, id, timestamp, ...data } = event as LoggedEvent & Record<string, unknown>;
      const envelope = createRuntimeEnvelope(kind, data as Record<string, unknown>);
      broadcast(envelope);
    },
  });

  runtimeEventSubscriptions.set(eventBusRef, subscription);
}
