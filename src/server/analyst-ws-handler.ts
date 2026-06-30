import type { WebSocket } from 'ws';
import { getAnalystHandler, resolveAnalystSessionId, sanitizeAnalystPayload, sanitizeAnalystText } from '../agents/analyst-api.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { InboundAnalystMessageEnvelopeSchema } from '../contracts/index.js';
import type { WsEnvelope } from '../contracts/index.js';
import { redactOperatorErrorMessage } from '../workspace/index.js';
import { LiveSyncSocket } from './live-sync-socket.js';
import { projectAnalystToolInvocationActivity } from './tool-activity-projection.js';

export interface AnalystWsHandlerOptions {
  projectRoot: string;
  liveSyncSocket: LiveSyncSocket;
  runtimeApplication: RuntimeApplication;
  requestServerRestart: () => Promise<void>;
  sendToClient: (ws: WebSocket, event: WsEnvelope) => void;
  broadcast: (event: WsEnvelope) => void;
}

export class AnalystWsHandler {
  private readonly sessions = new WeakMap<WebSocket, string>();
  private readonly turnQueues = new WeakMap<WebSocket, Promise<void>>();

  constructor(private readonly options: AnalystWsHandlerOptions) {}

  initialize(ws: WebSocket): string {
    const sessionId = resolveAnalystSessionId();
    this.sessions.set(ws, sessionId);
    return sessionId;
  }

  handleRawMessage(ws: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    return this.queueTurn(ws, async () => {
      try {
        const rawParsed = JSON.parse(this.rawToString(raw)) as unknown;
        if (this.options.liveSyncSocket.handleClientFrame(ws, rawParsed)) return;
        const parsed = InboundAnalystMessageEnvelopeSchema.safeParse(rawParsed);
        if (!parsed.success) throw new Error('Invalid analyst websocket message');

        let currentSessionId = this.sessions.get(ws);
        if (!currentSessionId) currentSessionId = this.initialize(ws);
        const handler = getAnalystHandler(this.options.projectRoot, {
          runtimeDeps: this.options.runtimeApplication.analystDeps,
          requestServerRestart: this.options.requestServerRestart,
          onActivity: (activity) => {
            this.options.broadcast({
              type: 'activity',
              content: sanitizeAnalystPayload(activity) as Record<string, unknown>,
            });
          },
        });
        const response = await handler.handleMessage(currentSessionId, parsed.data.content.text);

        this.options.sendToClient(ws, {
          type: 'message',
          content: sanitizeAnalystPayload(response.message, 200_000) as Record<string, unknown>,
        });

        for (const invocation of response.toolInvocations ?? []) {
          this.options.sendToClient(ws, {
            type: 'activity',
            content: projectAnalystToolInvocationActivity(invocation),
          });
        }
      } catch (err) {
        this.options.sendToClient(ws, {
          type: 'error',
          content: {
            error: 'Failed to process message',
            details: sanitizeAnalystText(redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), this.options.projectRoot), 200),
          },
        });
      }
    });
  }

  cleanup(ws: WebSocket): void {
    this.sessions.delete(ws);
    this.turnQueues.delete(ws);
  }

  private queueTurn(ws: WebSocket, turn: () => Promise<void>): Promise<void> {
    const previous = this.turnQueues.get(ws) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      if (ws.readyState !== ws.OPEN) return;
      await turn();
    });
    this.turnQueues.set(ws, next);
    next.finally(() => {
      if (this.turnQueues.get(ws) === next) this.turnQueues.delete(ws);
    }).catch(() => undefined);
    return next;
  }

  private rawToString(raw: Buffer | ArrayBuffer | Buffer[]): string {
    return typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString('utf-8')
        : Buffer.concat(raw as Buffer[]).toString('utf-8');
  }
}
