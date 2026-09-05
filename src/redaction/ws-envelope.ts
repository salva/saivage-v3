import {
  ServerEgressWsEnvelopeSchema,
  type ServerEgressWsEnvelope,
} from '../contracts/operator-events.js';
import { redactTextForOutbound } from './text.js';

export function projectWsEnvelopeForOutbound(
  envelope: ServerEgressWsEnvelope,
): ServerEgressWsEnvelope {
  switch (envelope.type) {
    case 'error':
      return ServerEgressWsEnvelopeSchema.parse(envelope);
    case 'status':
      switch (envelope.content.event) {
        case 'connected':
          return ServerEgressWsEnvelopeSchema.parse({
            type: 'status',
            content: {
              event: 'connected',
              sessionId: envelope.content.sessionId,
              timestamp: envelope.content.timestamp,
              clientCount: envelope.content.clientCount,
            },
          });
        case 'analyst_turn_acknowledged':
          return ServerEgressWsEnvelopeSchema.parse({ type: 'status', content: { ...envelope.content },
          });
      }
      return assertNever(envelope.content);
    case 'activity':
      return projectActivityEnvelope(envelope);
  }
}

function projectActivityEnvelope(
  envelope: Extract<ServerEgressWsEnvelope, { type: 'activity' }>,
): ServerEgressWsEnvelope {
  const content = envelope.content;
  switch (content.event) {
    case 'tool_invocation':
      return ServerEgressWsEnvelopeSchema.parse({ type: 'activity', content: { ...content },
      });
    case 'analyst_tool_invoked':
      return ServerEgressWsEnvelopeSchema.parse({
        type: 'activity',
        content: {
          event: content.event,
          sessionId: content.sessionId,
          tool: content.tool,
          success: content.success,
          summary: redactTextForOutbound(content.summary),
          ...copyOptional(content, ['classified_as', 'related_card_id', 'related_note_id', 'related_process_id',
          ]),
        },
      });
    case 'card_history_appended':
      return ServerEgressWsEnvelopeSchema.parse({
        type: 'activity',
        content: {
          event: content.event,
          card_id: content.card_id,
          version_seq: content.version_seq,
          changed_fields: [...content.changed_fields],
          changed_at: content.changed_at,
        },
      });
    case 'notification_added':
      return ServerEgressWsEnvelopeSchema.parse({
        type: 'activity',
        content: {
          event: content.event,
          session_id: content.session_id,
          kind: content.kind,
        },
      });
    case 'control_action_recorded':
      return ServerEgressWsEnvelopeSchema.parse({
        type: 'activity',
        content: {
          event: content.event,
          id: content.id,
          action: content.action,
          target_kind: content.target_kind,
          target_id: content.target_id,
          outcome: content.outcome,
          created_at: content.created_at,
          ...copyOptional(content, ['actor', 'surface']),
        },
      });
  }
  return assertNever(content);
}

function copyOptional(value: Record<string, unknown>, keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled WebSocket envelope content: ${JSON.stringify(value)}`);
}
