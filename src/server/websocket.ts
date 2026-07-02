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
import type { SaivageConfig } from '../agents/config-api.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { buildConnectedEnvelope, validateKnownWsEnvelope } from '../contracts/index.js';
import type { WsEnvelope, WsEventType } from '../contracts/index.js';
import { getAuthPolicy } from './auth-policy.js';
import { redactForOutbound, type Redacted } from '../redaction/index.js';
import { LiveSyncSocket } from './live-sync-socket.js';
import { AnalystWsHandler } from './analyst-ws-handler.js';

export type { WsEnvelope, WsEventType };

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

export interface RegisterWebSocketOptions {
  liveSyncSocket: LiveSyncSocket;
  saivageConfig: SaivageConfig;
  runtimeApplication: RuntimeApplication;
  requestServerRestart: () => Promise<void>;
}

export function registerWebSocket(fastify: FastifyInstance, projectRoot: string, options: RegisterWebSocketOptions): void {
  const liveSyncSocket = options.liveSyncSocket;
  const analystWsHandler = new AnalystWsHandler({
    projectRoot,
    saivageConfig: options.saivageConfig,
    liveSyncSocket,
    runtimeApplication: options.runtimeApplication,
    requestServerRestart: options.requestServerRestart,
    sendToClient,
    broadcast: (event) => broadcast(liveSyncSocket, event),
  });
  fastify.addHook('onClose', async () => {
    liveSyncSocket.dispose();
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

      const sessionId = analystWsHandler.initialize(ws);

      sendToClient(ws, buildConnectedEnvelope({
        sessionId,
        timestamp: new Date().toISOString(),
          clientCount: liveSyncSocket.clientCount(),
      }));

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        return analystWsHandler.handleRawMessage(ws, raw);
      });

      ws.on('close', () => {
        liveSyncSocket.delete(ws);
        analystWsHandler.cleanup(ws);
      });

      ws.on('error', () => {
        liveSyncSocket.delete(ws);
        analystWsHandler.cleanup(ws);
      });
    },
  );
}
