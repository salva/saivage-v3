import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { EventBus, toEventLogRecord, type DomainEvent } from '../../../src/events/index.js';
import { appendConversationMessage, buildContextTextMessage, createConversationChangePublisher, readConversationMessages } from '../../../src/runtime/actors/index.js';
import { mapLiveSyncEvent } from '../../../src/server/sync-hub.js';

describe('conversation change publisher', () => {
  it('emits conversation_changed after durable append and suppresses idempotent duplicates', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-publisher-'));
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribe('conversation_changed', (event) => { events.push(event); });
    const publisher = createConversationChangePublisher(bus);
    const message = { ...buildContextTextMessage('analyst:global', 'user', 'hello'), id: 'analyst-message', timestamp: '2026-01-01T00:00:00.000Z' };

    const first = appendConversationMessage(root, message);
    expect(readConversationMessages(root, 'analyst:global').map((row) => row.id)).toEqual(['analyst-message']);
    publisher.entryAppended(first);
    publisher.entryAppended(appendConversationMessage(root, message));

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ session_id: 'analyst:global', mutation: 'entry_appended', message_id: 'analyst-message', message_timestamp: message.timestamp });
    expect(mapLiveSyncEvent(events[0] as DomainEvent<any>)).toEqual([]);
    expect(toEventLogRecord(events[0] as DomainEvent).timestamp).toBe(events[0]?.timestamp);
  });

  it('does not emit when append persistence fails', () => {
    const bus = new EventBus();
    const handler = jest.fn();
    bus.subscribe('conversation_changed', (event) => { handler(event); });
    const publisher = createConversationChangePublisher(bus);

    expect(() => appendConversationMessage('/dev/null/not-a-project', buildContextTextMessage('analyst:global', 'user', 'hello'))).toThrow();
    publisher.entryAppended({ message: buildContextTextMessage('analyst:global', 'user', 'hello'), appended: false });

    expect(handler).not.toHaveBeenCalled();
  });
});
