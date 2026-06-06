import { describe, expect, it } from '@jest/globals';

import { mapLiveSyncEvent } from '../../src/server/sync-hub.js';
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
      sessionId: 'analyst',
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
});
