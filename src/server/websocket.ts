/**
 * WebSocket endpoint and live-sync wiring.
 *
 * Connection:  ws://host:port/ws
 * Auth:        Checked on upgrade; invalid → close 1008.
 *
 * Server event envelope (JSON):
 *   { "type": "activity | status | error", "content": { ... } }
 * Browser-to-server Analyst messages use their separate strict input contract.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { buildConnectedEnvelope, ServerEgressWsEnvelopeSchema,
} from '../contracts/index.js';
import type { ServerEgressWsEnvelope } from '../contracts/index.js';
import type { AuthPolicy } from './auth-policy.js';
import { redactForOutbound } from '../redaction/index.js';
import { LiveSyncSocket } from './live-sync-socket.js';
import { AnalystWsHandler } from './analyst-ws-handler.js';
import type { RestartCapability } from '../contracts/index.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../contracts/index.js';

export function serializeOutboundEnvelope(event: ServerEgressWsEnvelope): string {
  const classified = ServerEgressWsEnvelopeSchema.parse(event);
  const envelope = redactForOutbound({ source: 'ws-envelope', value: classified });
  return JSON.stringify(ServerEgressWsEnvelopeSchema.parse(envelope));
}

export function sendToClient(ws: WebSocket, event: ServerEgressWsEnvelope, callback?: (error?: Error) => void,
): void {
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
}

interface RegisterWebSocketOptions {
  authPolicy: AuthPolicy;
  liveSyncSocket: LiveSyncSocket;
  runtimeApplication: RuntimeApplication;
  restartCapability: RestartCapability;
  fatalPort: ApplicationFatalPort;
}

export function registerWebSocket(fastify: FastifyInstance,
  options: RegisterWebSocketOptions,
): void {
  const liveSyncSocket = options.liveSyncSocket;
  const analystWsHandler = new AnalystWsHandler({
    liveSyncSocket,
    runtimeApplication: options.runtimeApplication,
    restartCapability: options.restartCapability,
    sendToClient,
    fatalPort: options.fatalPort,
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

      const analystSessionId = analystWsHandler.initialize(ws);

      sendToClient(ws, buildConnectedEnvelope({
        sessionId: analystSessionId,
        timestamp: new Date().toISOString(),
        clientCount: liveSyncSocket.clientCount(),
      }),
    );

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        if (!liveSyncSocket.isAdmissionOpen()) return;
        void analystWsHandler.handleRawMessage(ws, raw, request.log).catch((error) => {
          if (error instanceof PublicationOutcomeUnknownError) options.fatalPort.publicationOutcomeUnknown(error);
        });
      });

      ws.on('close', () => {
        liveSyncSocket.delete(ws);
    });

      ws.on('error', () => {
        liveSyncSocket.delete(ws);
    });
    });
}
