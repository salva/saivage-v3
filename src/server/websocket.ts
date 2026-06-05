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
import { getOrCreateAnalystSession, getAnalystHandler, resetAnalystHandlerCache } from '../agents/analyst-api.js';
import { redactOperatorErrorMessage } from '../workspace/index.js';
import { sanitizeAnalystPayload, sanitizeAnalystText } from '../agents/analyst-api.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { InboundAnalystMessageEnvelopeSchema, buildConnectedEnvelope, validateKnownWsEnvelope } from '../contracts/index.js';
import type { WsEnvelope, WsEventType } from '../contracts/index.js';
import { getAuthPolicy } from './auth-policy.js';
import { redactForOutbound, type Redacted } from '../redaction/index.js';
import { LiveSyncSocket } from './live-sync-socket.js';

export type { WsEnvelope, WsEventType };

const wsSessions = new WeakMap<WebSocket, string>();
const analystTurnQueues = new WeakMap<WebSocket, Promise<void>>();

export function resetAnalystWebSocketState(projectRoot?: string): void {
  resetAnalystHandlerCache(projectRoot);
}

function serializeOutboundEnvelope(event: WsEnvelope): string {
  const envelope: Redacted<WsEnvelope> = redactForOutbound(validateKnownWsEnvelope(event) as WsEnvelope, 'operator.websocket', { source: 'websocket' });
  return JSON.stringify(envelope);
}

function broadcast(liveSyncSocket: LiveSyncSocket, event: WsEnvelope): void {
  const data = serializeOutboundEnvelope(event);
  liveSyncSocket.forEachClient((ws) => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    } catch { void 0; 
    }
  });
}

export function sendToClient(ws: WebSocket, event: WsEnvelope): void {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(serializeOutboundEnvelope(event));
    }
  } catch { void 0; 
  }
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
    if (ws.readyState !== ws.OPEN) {
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

export function registerWebSocket(fastify: FastifyInstance, projectRoot: string, liveSyncSocketOrRuntimeApplication?: LiveSyncSocket | RuntimeApplication, runtimeApplicationOrRequestRestart?: RuntimeApplication | (() => Promise<void>), requestServerRestartArg?: () => Promise<void>): void {
  const liveSyncSocket = liveSyncSocketOrRuntimeApplication instanceof LiveSyncSocket ? liveSyncSocketOrRuntimeApplication : new LiveSyncSocket();
  const runtimeApplication = liveSyncSocketOrRuntimeApplication instanceof LiveSyncSocket
    ? runtimeApplicationOrRequestRestart as RuntimeApplication | undefined
    : liveSyncSocketOrRuntimeApplication as RuntimeApplication | undefined;
  const requestServerRestart = liveSyncSocketOrRuntimeApplication instanceof LiveSyncSocket
    ? requestServerRestartArg
    : runtimeApplicationOrRequestRestart as (() => Promise<void>) | undefined;
  fastify.addHook('onClose', async () => {
    liveSyncSocket.dispose();
    resetAnalystWebSocketState(projectRoot);
  });

  fastify.get(
    '/ws',
    { websocket: true },
    (ws: WebSocket, request: FastifyRequest) => {
      if (!checkAuth(request)) {
        rejectUnauthorizedWebSocket(ws);
        return;
      }

      liveSyncSocket.add(ws);

      const { sessionId } = getOrCreateAnalystSession(projectRoot);
      wsSessions.set(ws, sessionId);

      sendToClient(ws, buildConnectedEnvelope({
        sessionId,
        timestamp: new Date().toISOString(),
          clientCount: liveSyncSocket.clientCount(),
      }));

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
            if (liveSyncSocket.handleClientFrame(ws, rawParsed)) return;
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

              if (!runtimeApplication) throw new Error('Runtime application unavailable for analyst websocket.');
              const handler = getAnalystHandler(projectRoot, {
                runtimeDeps: runtimeApplication.analystDeps,
                requestServerRestart,
                onActivity: (activity) => {
                  const sanitizedActivity = sanitizeAnalystPayload(activity) as Record<string, unknown>;
                  broadcast(liveSyncSocket, { type: 'activity', content: sanitizedActivity });
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
        liveSyncSocket.delete(ws);
        wsSessions.delete(ws);
        analystTurnQueues.delete(ws);
      });

      ws.on('error', () => {
        liveSyncSocket.delete(ws);
        wsSessions.delete(ws);
        analystTurnQueues.delete(ws);
      });
    },
  );
}
