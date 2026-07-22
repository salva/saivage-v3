/**
 * WebSocket endpoint and live-sync wiring.
 *
 * Connection:  ws://host:port/ws
 * Auth:        Checked on upgrade; invalid → close 1008.
 *
 * Message envelope (JSON):
 *   { "type": "message | activity | thinking | status | error", "content": { ... } }
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { SaivageConfig } from '../schemas/saivage-config.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { buildConnectedEnvelope, KnownWsEnvelopeWithClassifiedToolActivitySchema } from '../contracts/index.js';
import type { WsEnvelope, WsEventType } from '../contracts/index.js';
import type { AuthPolicy } from './auth-policy.js';
import { redactForOutbound } from '../redaction/index.js';
import { LiveSyncSocket } from './live-sync-socket.js';
import { AnalystWsHandler } from './analyst-ws-handler.js';
import type { RestartPort } from '../boot/restart-port.js';
import { AppLogPublicationError } from '../persistence/app-log.js';

export type { WsEnvelope, WsEventType };

export function serializeOutboundEnvelope(event: WsEnvelope): string {
  const classified = KnownWsEnvelopeWithClassifiedToolActivitySchema.parse(event);
  const envelope = redactForOutbound({ source: 'ws-envelope', value: classified });
  return JSON.stringify(KnownWsEnvelopeWithClassifiedToolActivitySchema.parse(envelope));
}

export function sendToClient(ws: WebSocket, event: WsEnvelope, callback?: (error?: Error) => void): void {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(serializeOutboundEnvelope(event), callback);
    }
  } catch { void 0; 
  }
}

function checkAuth(policy: AuthPolicy, request: FastifyRequest): boolean {
  return policy.validateWebSocketRequest(request).ok;
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
  authPolicy: AuthPolicy;
  liveSyncSocket: LiveSyncSocket;
  saivageConfig: SaivageConfig;
  runtimeApplication: RuntimeApplication;
  restartPort?: RestartPort;
}

export function registerWebSocket(fastify: FastifyInstance, projectRoot: string, options: RegisterWebSocketOptions): void {
  const liveSyncSocket = options.liveSyncSocket;
  const analystWsHandler = new AnalystWsHandler({
    projectRoot,
    saivageConfig: options.saivageConfig,
    liveSyncSocket,
    runtimeApplication: options.runtimeApplication,
    restartPort: options.restartPort,
    sendToClient,
  });
  fastify.get(
    '/ws',
    { websocket: true },
    (ws: WebSocket, request: FastifyRequest) => {
      if (!checkAuth(options.authPolicy, request)) {
        rejectUnauthorizedWebSocket(ws);
        return;
      }

      liveSyncSocket.add(ws);

      analystWsHandler.initialize(ws);

      sendToClient(ws, buildConnectedEnvelope({
        timestamp: new Date().toISOString(),
          clientCount: liveSyncSocket.clientCount(),
      }));

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        if (!liveSyncSocket.isAdmissionOpen()) return;
        void analystWsHandler.handleRawMessage(ws, raw).catch((error) => {
          if (error instanceof AppLogPublicationError) {
            request.log.error({ code: 'app_log_publication_failed', entryType: error.entryType, transport: 'websocket' }, 'Required app-log publication failed');
            return;
          }
          request.log.error({ code: 'analyst_websocket_message_failed', transport: 'websocket' }, 'Analyst WebSocket message failed');
        });
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
