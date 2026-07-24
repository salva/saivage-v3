import {
  KnownWsEnvelopeWithClassifiedToolActivitySchema,
  type KnownWsEnvelopeWithClassifiedToolActivity,
} from '../contracts/operator-events.js';
import { projectDynamicForOutbound } from './dynamic.js';
import { redactTextForOutbound } from './text.js';

export function projectWsEnvelopeForOutbound(
  envelope: KnownWsEnvelopeWithClassifiedToolActivity,
): KnownWsEnvelopeWithClassifiedToolActivity {
  switch (envelope.type) {
    case 'message':
      return KnownWsEnvelopeWithClassifiedToolActivitySchema.parse({
        type: 'message',
        content: {
          ...projectPassthrough(envelope.content, ['text']),
          text: redactTextForOutbound(envelope.content.text),
        },
      });
    case 'error':
      return KnownWsEnvelopeWithClassifiedToolActivitySchema.parse({
        type: 'error',
        content: projectDynamicForOutbound(envelope.content),
      });
    case 'status':
      switch (envelope.content.event) {
        case 'connected':
          return KnownWsEnvelopeWithClassifiedToolActivitySchema.parse({
            type: 'status',
            content: {
              ...projectPassthrough(envelope.content, ['event', 'sessionId', 'timestamp', 'clientCount']),
              event: 'connected',
              sessionId: envelope.content.sessionId,
              timestamp: envelope.content.timestamp,
              clientCount: envelope.content.clientCount,
            },
          });
        case 'analyst_turn_acknowledged':
          return KnownWsEnvelopeWithClassifiedToolActivitySchema.parse({ type: 'status', content: { ...envelope.content } });
      }
      return assertNever(envelope.content);
    case 'activity':
      return projectActivityEnvelope(envelope);
  }
}

function projectActivityEnvelope(
  envelope: Extract<KnownWsEnvelopeWithClassifiedToolActivity, { type: 'activity' }>,
): KnownWsEnvelopeWithClassifiedToolActivity {
  const content = envelope.content;
  switch (content.event) {
    case 'tool_invocation':
      return KnownWsEnvelopeWithClassifiedToolActivitySchema.parse({ type: 'activity', content: { ...content } });
    case 'analyst_tool_invoked':
      return KnownWsEnvelopeWithClassifiedToolActivitySchema.parse({
        type: 'activity',
        content: {
          ...projectPassthrough(content, ['event', 'sessionId', 'tool', 'success', 'summary', 'classified_as', 'related_card_id', 'related_note_id', 'related_process_id']),
          event: content.event,
          sessionId: content.sessionId,
          tool: content.tool,
          success: content.success,
          summary: redactTextForOutbound(content.summary),
          ...copyOptional(content, ['classified_as', 'related_card_id', 'related_note_id', 'related_process_id']),
        },
      });
    case 'card_history_appended':
      return KnownWsEnvelopeWithClassifiedToolActivitySchema.parse({
        type: 'activity',
        content: {
          ...projectPassthrough(content, ['event', 'card_id', 'version_seq', 'changed_fields', 'changed_at']),
          event: content.event,
          card_id: content.card_id,
          version_seq: content.version_seq,
          changed_fields: [...content.changed_fields],
          changed_at: content.changed_at,
        },
      });
    case 'notification_added':
      return KnownWsEnvelopeWithClassifiedToolActivitySchema.parse({
        type: 'activity',
        content: {
          ...projectPassthrough(content, ['event', 'session_id', 'kind']),
          event: content.event,
          session_id: content.session_id,
          kind: content.kind,
        },
      });
    case 'control_action_recorded':
      return KnownWsEnvelopeWithClassifiedToolActivitySchema.parse({
        type: 'activity',
        content: {
          ...projectPassthrough(content, ['event', 'id', 'action', 'target_kind', 'target_id', 'outcome', 'created_at', 'actor', 'surface']),
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
}

function projectPassthrough(value: Record<string, unknown>, ownedKeys: readonly string[]): Record<string, unknown> {
  const owned = new Set(ownedKeys);
  const passthrough = Object.fromEntries(Object.entries(value).filter(([key]) => !owned.has(key)));
  return projectDynamicForOutbound(passthrough) as Record<string, unknown>;
}

function copyOptional(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled WebSocket envelope content: ${JSON.stringify(value)}`);
}
