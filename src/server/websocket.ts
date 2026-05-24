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
import { getOrCreateAnalystSession, getAnalystHandler, resetAnalystHandlerCache } from '../agents/index.js';
import type { EventBus, Subscription, DomainEvent } from '../events/index.js';
import { toLoggedEvent } from '../events/index.js';
import { operatorBroadcastEventKindValues, type OperatorBroadcastEventKind } from '../events/index.js';
import { redactOperatorErrorMessage } from '../workspace/index.js';
import { sanitizeAnalystPayload, sanitizeAnalystText } from '../agents/index.js';
import type { ActiveRuntime } from '../runtime/index.js';
import { InboundAnalystMessageEnvelopeSchema, buildConnectedEnvelope, validateKnownWsEnvelope } from '../contracts/index.js';
import type { WsEnvelope, WsEventType } from '../contracts/index.js';
import { getAuthPolicy } from './auth-policy.js';
import { redactForOutbound, type Redacted } from '../redaction/index.js';

export type { WsEnvelope, WsEventType };

const clients = new Set<WebSocket>();
const authenticatedClients = new Set<WebSocket>();
const wsSessions = new WeakMap<WebSocket, string>();
const analystTurnQueues = new WeakMap<WebSocket, Promise<void>>();
const runtimeEventSubscriptions = new Map<object, Subscription>();

export function resetWebSocketState(projectRoot?: string): void {
  for (const ws of clients) {
    try {
      ws.removeAllListeners();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close();
      }
    } catch { void 0; 
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

function serializeOutboundEnvelope(event: WsEnvelope): string {
  const envelope: Redacted<WsEnvelope> = redactForOutbound(validateKnownWsEnvelope(event) as WsEnvelope, 'operator.websocket', { source: 'websocket' });
  return JSON.stringify(envelope);
}

export function broadcast(event: WsEnvelope): void {
  const data = serializeOutboundEnvelope(event);
  for (const ws of authenticatedClients) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    } catch { void 0; 
    }
  }
}

export function sendToClient(ws: WebSocket, event: WsEnvelope): void {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(serializeOutboundEnvelope(event));
    }
  } catch { void 0; 
  }
}

export function sendRuntimeStateSnapshotToClient(ws: WebSocket, activeRuntime?: ActiveRuntime): void {
  const content: WsEnvelope['content'] = { event: 'runtime-state' };
  void activeRuntime;
  sendToClient(ws, { type: 'status', content });
}

export function getClientCount(): number {
  return clients.size;
}

export function getRuntimeEventSubscriptionCount(): number {
  return runtimeEventSubscriptions.size;
}

function checkAuth(request: FastifyRequest): boolean {
  return getAuthPolicy().validateWebSocketRequest(request).ok;
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

      sendToClient(ws, buildConnectedEnvelope({
        sessionId,
        timestamp: new Date().toISOString(),
        clientCount: authenticatedClients.size,
      }));
      sendRuntimeStateSnapshotToClient(ws, activeRuntime);

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        return queueAnalystTurn(ws, async () => {
          try {
            const data =
              typeof raw === 'string'
                ? raw
                : Buffer.isBuffer(raw)
                  ? raw.toString('utf-8')
                  : Buffer.concat(raw as Buffer[]).toString('utf-8');
            const rawParsed = JSON.parse(data) as unknown;
            const parsed = InboundAnalystMessageEnvelopeSchema.safeParse(rawParsed);

            if (!parsed.success) {
              throw new Error('Invalid analyst websocket message');
            }

            {
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
                parsed.data.content.text,
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
  const fromCoveredName = (event: WsEnvelope): WsEnvelope => validateKnownWsEnvelope(event) as WsEnvelope;
  switch (eventName) {
    case 'goal_completed':
      return fromCoveredName({ type: 'status', content: { event: eventName, ...data } });
    case 'goal_failed':
      return { type: 'error', content: { event: eventName, ...data } };
    case 'escalation':
      return fromCoveredName({ type: 'status', content: { event: eventName, ...data } });
    case 'card_failed':
      return { type: 'error', content: { event: eventName, ...data } };
    case 'runtime_command':
      return fromCoveredName({ type: 'activity', content: { event: 'runtime.command', command: data['command'] ?? data } });
    case 'runtime_run':
      return fromCoveredName({ type: 'status', content: { event: 'runtime.run', run: data['run'] ?? data } });
    case 'runtime_activation':
      return fromCoveredName({ type: 'activity', content: { event: 'runtime.activation', activation: data['activation'] ?? data } });
    case 'runtime_actionable_error':
      return fromCoveredName({ type: 'error', content: { event: 'runtime.actionable_error', actionable_error: data['actionable_error'] ?? data['error'] ?? data } });
    case 'card_history_appended':
    case 'notification_added':
    case 'notification_acknowledged':
    case 'control_action_recorded':
      return fromCoveredName({ type: 'activity', content: { event: eventName, ...data } });
    case 'analyst_tool_invoked':
      return fromCoveredName({ type: 'activity', content: { event: eventName, ...data, summary: sanitizeAnalystText(String(data['summary'] ?? ''), 200) } });
    case 'card_planner_state_changed':
      return fromCoveredName({ type: 'status', content: { event: 'card.planner_state_changed', ...data } });
    case 'review_complete':
      return fromCoveredName({ type: 'status', content: { event: eventName, ...data } });
    case 'plan_updated':
      return { type: 'activity', content: { event: eventName, ...data } };
    default:
      return fromCoveredName({ type: 'status', content: { event: eventName, ...data } });
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
    allowedKinds: [...operatorBroadcastEventKindValues],
    handler: (event: DomainEvent<OperatorBroadcastEventKind>) => {
      const logged = 'payload' in event ? toLoggedEvent(event) : event as unknown as Record<string, unknown>;
      const { kind, id, timestamp, ...data } = logged as Record<string, unknown> & { kind: OperatorBroadcastEventKind }; void id; void timestamp;
      const envelope = createRuntimeEnvelope(kind, data as Record<string, unknown>);
      broadcast(envelope);
    },
  });

  runtimeEventSubscriptions.set(eventBusRef, subscription);
}
