import type { WebSocket } from 'ws';
import type { SaivageConfig } from '../agents/config-api.js';
import { sanitizeAnalystText } from '../agents/analyst-api.js';
import { GLOBAL_ANALYST_SESSION_ID } from '../schemas/index.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { InboundAnalystMessageEnvelopeSchema } from '../contracts/index.js';
import type { WsEnvelope } from '../contracts/index.js';
import type { RestartPort } from '../boot/restart-port.js';
import { redactOperatorErrorMessage } from '../workspace/index.js';
import { LiveSyncSocket } from './live-sync-socket.js';
import { projectAnalystToolInvocationActivity } from './tool-activity-projection.js';
import { rethrowAppLogPublicationError } from '../persistence/app-log.js';

export interface AnalystWsHandlerOptions {
  projectRoot: string;
  saivageConfig: SaivageConfig;
  liveSyncSocket: LiveSyncSocket;
  runtimeApplication: RuntimeApplication;
  restartPort?: RestartPort;
  sendToClient: (ws: WebSocket, event: WsEnvelope, callback?: (error?: Error) => void) => void;
}

export class AnalystWsHandler {
  private readonly turnQueues = new WeakMap<WebSocket, Promise<void>>();

  constructor(private readonly options: AnalystWsHandlerOptions) {}

  initialize(_ws: WebSocket): string {
    return GLOBAL_ANALYST_SESSION_ID;
  }

  handleRawMessage(ws: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    return this.queueTurn(ws, async () => {
      try {
        const rawParsed = JSON.parse(this.rawToString(raw)) as unknown;
        if (this.options.liveSyncSocket.handleClientFrame(ws, rawParsed)) return;
        const parsed = InboundAnalystMessageEnvelopeSchema.safeParse(rawParsed);
        if (!parsed.success) throw new Error('Invalid analyst websocket message');

        const response = await this.options.runtimeApplication.analystRuntime.submit({ userContent: parsed.data.content.text });

        for (const invocation of response.toolInvocations ?? []) {
          this.options.sendToClient(ws, {
            type: 'activity',
            content: projectAnalystToolInvocationActivity(invocation),
          });
        }
        const restartPort = response.restart?.status === 'scheduled' ? this.options.restartPort : undefined;
        if (response.restart?.status === 'scheduled' && !restartPort) throw new Error('Scheduled restart acknowledgement requires an application-owned restart port.');
        this.options.sendToClient(ws, {
          type: 'status',
          content: { event: 'analyst_turn_acknowledged', sessionId: response.sessionId, restart: response.restart },
        }, (error) => {
          if (error || response.restart?.status !== 'scheduled') return;
          void restartPort!.acknowledge();
        });
      } catch (err) {
        rethrowAppLogPublicationError(err);
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
