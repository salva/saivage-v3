import type { WebSocket } from 'ws';
import { AnalystTurnBusyError } from '../agents/analyst-api.js';
import type { RuntimeApplication } from '../application/runtime-composition.js';
import { InboundAnalystMessageEnvelopeSchema } from '../contracts/index.js';
import type { ServerEgressWsEnvelope } from '../contracts/operator-events.js';
import type { RestartPort } from '../boot/restart-port.js';
import { LiveSyncSocket } from './live-sync-socket.js';
import { projectAnalystToolInvocationActivity } from './tool-activity-projection.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../contracts/index.js';
import { ANALYST_PROCESSING_FAILED_ERROR } from '../contracts/operator-events.js';
import { ANALYST_TURN_BUSY_ERROR } from '../contracts/operator-api-chats.js';
import type { GlobalConversationSessionId } from '../schemas/index.js';

export interface AnalystWsHandlerOptions {
  liveSyncSocket: LiveSyncSocket;
  runtimeApplication: RuntimeApplication;
  restartPort?: RestartPort;
  sendToClient: (ws: WebSocket, event: ServerEgressWsEnvelope, callback?: (error?: Error) => void,
  ) => void;
  fatalPort: ApplicationFatalPort;
}

export class AnalystWsHandler {
  constructor(private readonly options: AnalystWsHandlerOptions) {}

  initialize(_ws: WebSocket): GlobalConversationSessionId {
    return this.options.runtimeApplication.analystSessionId;
  }

  async handleRawMessage(ws: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    try {
        const rawParsed = JSON.parse(this.rawToString(raw)) as unknown;
        if (this.options.liveSyncSocket.handleClientFrame(ws, rawParsed)) return;
        const parsed = InboundAnalystMessageEnvelopeSchema.safeParse(rawParsed);
        if (!parsed.success) throw new Error('Invalid analyst websocket message');

        const response = await this.options.runtimeApplication.analystRuntime.submit({ userContent: parsed.data.content.text,
      });

        for (const invocation of response.toolInvocations ?? []) {
          this.options.sendToClient(ws, {
            type: 'activity',
            content: projectAnalystToolInvocationActivity(invocation,this.options.runtimeApplication.analystSessionId,
          ),
          });
        }
        const restartPort = response.restart?.status === 'scheduled' ? this.options.restartPort : undefined;
        if (response.restart?.status === 'scheduled' && !restartPort) throw new Error('Scheduled restart acknowledgement requires an application-owned restart port.',
        );
        this.options.sendToClient(ws, {
          type: 'status',
          content: { event: 'analyst_turn_acknowledged', sessionId: response.sessionId, restart: response.restart,
          },
        }, (error) => {
          if (error || response.restart?.status !== 'scheduled') return;
          void restartPort!.acknowledge();
        },
      );
      } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) {
        this.options.fatalPort.publicationOutcomeUnknown(error);
        throw error;
      }
      this.options.sendToClient(ws, {
          type: 'error',
          content:
          error instanceof AnalystTurnBusyError
            ? ANALYST_TURN_BUSY_ERROR
            : ANALYST_PROCESSING_FAILED_ERROR,
      });
      }
    }

  private rawToString(raw: Buffer | ArrayBuffer | Buffer[]): string {
    return typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString('utf-8')
        : Buffer.concat(raw as Buffer[]).toString('utf-8');
  }
}
