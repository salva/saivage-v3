import { describe, expect, it } from '@jest/globals';

import { mapLiveSyncEvent } from '../../src/server/sync-hub.js';
import { EventBus } from '../../src/events/index.js';
import type { DomainEvent } from '../../src/events/index.js';

function event(kind: string, payload: Record<string, unknown>): DomainEvent<any> {
  return {
    id: `evt-${kind}`,
    kind,
    timestamp: new Date(0).toISOString(),
    payload,
  } as DomainEvent<any>;
}

describe('mapLiveSyncEvent', () => {
  it('invalidates cards for analyst card tools', () => {
    expect(mapLiveSyncEvent(event('analyst_tool_invoked', {
      sessionId: 'analyst:global',
      tool: 'create_card',
      success: true,
      summary: 'created card project',
    }))).toEqual(expect.arrayContaining([{ resource: 'cards' }, { resource: 'timeline' }]));
  });

  it('invalidates cards for card control actions', () => {
    expect(mapLiveSyncEvent(event('control_action_recorded', {
      id: 'audit-1',
      action: 'card.create',
      target_kind: 'card',
      target_id: 'project',
      outcome: 'ok',
      created_at: new Date(0).toISOString(),
    }))).toEqual(expect.arrayContaining([{ resource: 'cards' }, { resource: 'timeline' }]));
  });

  it('maps conversation_changed to a scoped conversation invalidation', () => {
    expect(mapLiveSyncEvent(event('conversation_changed', {
      session_id: 'analyst:global',
      mutation: 'entry_appended',
      message_id: 'msg-1',
      message_kind: 'tool_result',
      role: 'tool',
      message_timestamp: new Date(1).toISOString(),
    }))).toEqual([{ resource: 'conversation', id: 'analyst:global' }]);
  });

  it('does not map tool activity events to conversation invalidations', () => {
    expect(mapLiveSyncEvent(event('mcp_tool_invocation', { session_id: 'planner:project', role: 'planner', server_name: 'mcp', tool_name: 'read', success: true }))).toEqual([]);
    expect(mapLiveSyncEvent(event('analyst_tool_invoked', { sessionId: 'analyst:global', tool: 'read', success: true, summary: 'read file' }))).toEqual([{ resource: 'timeline' }]);
  });

  it('rejects reserved timestamp and unknown conversation_changed payload keys', () => {
    const bus = new EventBus();
    const payload = { session_id: 'analyst:global', mutation: 'entry_appended', message_id: 'msg-1', message_kind: 'text', role: 'assistant', message_timestamp: new Date(1).toISOString() } as const;
    expect(() => bus.emit('conversation_changed', { ...payload, timestamp: new Date(2).toISOString() } as never)).toThrow();
    expect(() => bus.emit('conversation_changed', { ...payload, extra: true } as never)).toThrow();
  });
});
