import { describe, expect, it } from 'vitest';
import type { AgentConversationEntry } from '../../api/types';
import { activationEntries } from './activation';
import { entriesToTimeline } from './timeline';

function markerEntry(sessionId: AgentConversationEntry['session_id'], id: string): AgentConversationEntry {
  const [, agent_name, scope] = sessionId.split(':');
  const timestamp = '2026-10-02T12:00:00.000Z';
  return {
    id, session_id: sessionId, role: 'system', kind: 'activity',
    content: JSON.stringify({ event: 'activation_open', agent_name, ...(scope === 'global' ? {} : { card_id: scope }), input_id: '11111111-1111-4111-8111-111111111111', timestamp }),
    context_policy: { kind: 'structural', behavior: 'activation_boundary' },
    timestamp, round_id: 'r-pre-11111111111141118111111111111111', message_index: 0, block_index: 0,
  };
}

describe('public selected-segment activation projection', () => {
  it('retains physical source order and real marker-only anchors without node attribution', () => {
    const first = markerEntry('agent:planner:project', 'agent:planner:project:activation:0123456789abcdef');
    const second = { ...markerEntry('agent:planner:project', 'agent:planner:project:activation:fedcba9876543210'), timestamp: '2026-10-01T12:00:00.000Z' };
    second.content = first.content.replace(first.timestamp, second.timestamp);
    expect(activationEntries([first, second]).map((marker) => marker.entry.id)).toEqual([first.id, second.id]);
    expect(entriesToTimeline([first]).rounds[0].rows.map((row) => row.entry)).toEqual([first]);
    expect(activationEntries([first])[0]).toEqual({ entry: first, agentName: 'planner', cardId: 'project', inputId: '11111111-1111-4111-8111-111111111111' });
  });

  it('ignores other activity but rejects malformed claimed markers', () => {
    const marker = markerEntry('agent:oversight:global', 'agent:oversight:global:activation:11111111-1111-4111-8111-111111111111');
    expect(activationEntries([{ ...marker, content: '{"event":"other"}' }])).toEqual([]);
    expect(activationEntries([{ ...marker, content: '{"event":"activation_open"' }])).toEqual([]);
    expect(() => activationEntries([{ ...marker, content: '{"event":"activation_open"}' }])).toThrow('Malformed activation_open');
    expect(() => activationEntries([{ ...marker, role: 'assistant' }])).toThrow('Malformed activation_open');
    expect(() => activationEntries([{ ...marker, context_policy: { kind: 'structural', behavior: 'provider_failure' } }])).toThrow('Malformed activation_open');
  });
});
