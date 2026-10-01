/**
 * WebSocket endpoint and live-sync wiring.
 *
 * Connection:  ws://host:port/ws
 * Auth:        Checked on upgrade; invalid → close 1008.
 *
 * Server event envelope (JSON):
 *   { "type": "status", "content": { "event": "connected", ... } }
 * Browser input is strict live-sync subscribe/unsubscribe only.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { buildConnectedEnvelope, ServerEgressWsEnvelopeSchema,
} from '../contracts/index.js';
import type { ServerEgressWsEnvelope } from '../contracts/index.js';
import type { AuthPolicy } from './auth-policy.js';
import { redactForOutbound } from '../redaction/artifact-api.js';
import { LiveSyncSocket } from './live-sync-socket.js';

export function serializeOutboundEnvelope(event: ServerEgressWsEnvelope): string {
  const classified = ServerEgressWsEnvelopeSchema.parse(event);
  const envelope = redactForOutbound({ source: 'ws-envelope', value: classified });
  return JSON.stringify(ServerEgressWsEnvelopeSchema.parse(envelope));
}

export function sendToClient(ws: WebSocket, event: ServerEgressWsEnvelope): void {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(serializeOutboundEnvelope(event));
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
}

export function registerWebSocket(fastify: FastifyInstance,
  options: RegisterWebSocketOptions,
): void {
  const liveSyncSocket = options.liveSyncSocket;
  fastify.get(
    '/ws',
    { websocket: true },
    (ws: WebSocket, request: FastifyRequest) => {
      if (!checkAuth(options.authPolicy, request)) {
        rejectUnauthorizedWebSocket(ws);
        return;
      }

      liveSyncSocket.add(ws);

      sendToClient(ws, buildConnectedEnvelope({
        timestamp: new Date().toISOString(),
        clientCount: liveSyncSocket.clientCount(),
      }));

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        if (!liveSyncSocket.isAdmissionOpen()) return;
        let input: unknown;
        try {
          const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
          input = JSON.parse(bytes.toString('utf-8'));
        } catch {
          ws.close(1008, 'Invalid live-sync frame');
          return;
        }
        if (!liveSyncSocket.handleClientFrame(ws, input)) ws.close(1008, 'Invalid live-sync frame');
      });

      ws.on('close', () => {
        liveSyncSocket.delete(ws);
      });

      ws.on('error', () => {
        liveSyncSocket.delete(ws);
      });
    });
}
