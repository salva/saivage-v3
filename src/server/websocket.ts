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
import { getOrCreateAnalystSession, getAnalystHandler, resetAnalystHandlerCache } from '../agents/analyst-handler.js';
import type { EventBus, EventBusSubscription } from '../utils/event-bus.js';
import type { LoggedEvent } from '../schemas/types.js';
import { redactOperatorErrorMessage } from '../utils/file-access-security.js';
import { sanitizeAnalystPayload, sanitizeAnalystText } from '../utils/analyst-sanitization.js';
import type { ActiveRuntime } from '../utils/active-runtime.js';

export type WsEventType = 'message' | 'activity' | 'thinking' | 'status' | 'error';

export interface WsEnvelope {
  type: WsEventType;
  content: Record<string, unknown>;
}

const clients = new Set<WebSocket>();
const authenticatedClients = new Set<WebSocket>();
const wsSessions = new WeakMap<WebSocket, string>();
const analystTurnQueues = new WeakMap<WebSocket, Promise<void>>();
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
  authenticatedClients.clear();

  resetAnalystHandlerCache(projectRoot);
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
  for (const ws of authenticatedClients) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    } catch {
    }
  }
}

export function broadcastCardHistoryAppended(payload: {
  card_id: string;
  version_seq: number;
  changed_fields: string[];
  changed_at: string;
}): void {
  broadcast({
    type: 'activity',
    content: {
      event: 'card_history_appended',
      ...payload,
    },
  });
}

export function broadcastNotificationAdded(payload: {
  id: string;
  kind: string;
  severity: string;
  related_card_id?: string;
  related_note_id?: string;
  related_process_id?: string;
  related_version_seq?: number;
  created_at: string;
}): void {
  broadcast({
    type: 'activity',
    content: {
      event: 'notification_added',
      ...payload,
    },
  });
}

export function broadcastNotificationAcknowledged(payload: {
  id: string;
  kind: string;
  related_card_id?: string;
  related_note_id?: string;
  related_process_id?: string;
  acknowledged_at: string;
}): void {
  broadcast({
    type: 'activity',
    content: {
      event: 'notification_acknowledged',
      ...payload,
    },
  });
}

export function broadcastControlActionRecorded(payload: {
  id: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  outcome: string;
  created_at: string;
  actor?: string;
  surface?: string;
}): void {
  broadcast({
    type: 'activity',
    content: {
      event: 'control_action_recorded',
      ...payload,
    },
  });
}

export function broadcastAnalystToolInvoked(payload: {
  sessionId: string;
  tool: string;
  success: boolean;
  summary: string;
  classified_as?: string;
  related_card_id?: string;
  related_note_id?: string;
  related_process_id?: string;
}): void {
  broadcast({
    type: 'activity',
    content: {
      event: 'analyst_tool_invoked',
      ...payload,
      summary: sanitizeAnalystText(payload.summary, 200),
    },
  });
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

function queueAnalystTurn(ws: WebSocket, turn: () => Promise<void>): Promise<void> {
  const previous = analystTurnQueues.get(ws) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    if (!authenticatedClients.has(ws) || ws.readyState !== ws.OPEN) {
      return;
    }
    await turn();
  });
  analystTurnQueues.set(ws, next);
  next.finally(() => {
    if (analystTurnQueues.get(ws) === next) {
      analystTurnQueues.delete(ws);
    }
  }).catch(() => undefined);
  return next;
}

export function registerWebSocket(fastify: FastifyInstance, projectRoot: string, activeRuntime?: ActiveRuntime): void {
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
      authenticatedClients.add(ws);

      const { sessionId } = getOrCreateAnalystSession(projectRoot);
      wsSessions.set(ws, sessionId);

      sendToClient(ws, {
        type: 'status',
        content: {
          event: 'connected',
          sessionId,
          timestamp: new Date().toISOString(),
          clientCount: authenticatedClients.size,
        },
      });

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        return queueAnalystTurn(ws, async () => {
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

              const handler = getAnalystHandler(projectRoot, {
                activeRuntime,
                onActivity: (activity) => {
                  const sanitizedActivity = sanitizeAnalystPayload(activity) as Record<string, unknown>;
                  broadcast({ type: 'activity', content: sanitizedActivity });
                },
              });
              const response = await handler.handleMessage(
                currentSessionId,
                String(parsed.content.text),
              );

              sendToClient(ws, {
                type: 'message',
                content: sanitizeAnalystPayload(response.message, 200_000) as Record<string, unknown>,
              });

              if (response.toolInvocations) {
                for (const inv of response.toolInvocations) {
                  sendToClient(ws, {
                    type: 'activity',
                    content: {
                      event: 'tool_invocation',
                      tool: inv.tool,
                      params: sanitizeAnalystPayload(inv.params),
                      result: sanitizeAnalystPayload({
                        success: inv.result.success,
                        error: inv.result.error,
                        preview: inv.result.preview
                          ? {
                              type: inv.result.preview.type,
                              summary: inv.result.preview.summary,
                              warnings: inv.result.preview.warnings,
                              classified_as: (inv.result.preview as unknown as Record<string, unknown>)['classified_as'],
                            }
                          : undefined,
                        data: inv.result.data && typeof inv.result.data === 'object'
                          ? {
                              classified_as: (inv.result.data as Record<string, unknown>)['classified_as'],
                              exit_code: (inv.result.data as Record<string, unknown>)['exit_code'],
                              duration_ms: (inv.result.data as Record<string, unknown>)['duration_ms'],
                              truncated: (inv.result.data as Record<string, unknown>)['truncated'],
                              stdout: (inv.result.data as Record<string, unknown>)['stdout'],
                              stderr: (inv.result.data as Record<string, unknown>)['stderr'],
                              command: (inv.result.data as Record<string, unknown>)['command'],
                              cwd: (inv.result.data as Record<string, unknown>)['cwd'],
                              path: (inv.result.data as Record<string, unknown>)['path'],
                              binary: (inv.result.data as Record<string, unknown>)['binary'],
                              size: (inv.result.data as Record<string, unknown>)['size'],
                              modified_at: (inv.result.data as Record<string, unknown>)['modified_at'],
                            }
                          : inv.result.data,
                      }),
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
                details: sanitizeAnalystText(redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot), 200),
              },
            });
          }
        });
      });

      ws.on('close', () => {
        clients.delete(ws);
        authenticatedClients.delete(ws);
        wsSessions.delete(ws);
        analystTurnQueues.delete(ws);
      });

      ws.on('error', () => {
        clients.delete(ws);
        authenticatedClients.delete(ws);
        wsSessions.delete(ws);
        analystTurnQueues.delete(ws);
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
