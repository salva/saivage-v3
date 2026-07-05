import { describe, expect, it } from 'vitest';
import type { AgentConversationEntry } from '../../api/types';
import { entriesToTimeline } from './timeline';

function entry(overrides: Partial<AgentConversationEntry>): AgentConversationEntry {
  return {
    id: 'msg-x',
    session_id: 's1',
    role: 'assistant',
    kind: 'text',
    content: '',
    round_id: 'r-assistant-0000000000000000000000000000000a',
    message_index: 0,
    block_index: 0,
    timestamp: '2026-05-30T00:00:00Z',
    ...overrides,
  };
}

describe('entriesToTimeline tool pairing', () => {
  it('pairs assistant tool_call (no top-level tool_call_id) with tool_result via content tool_calls[0].id', () => {
    const call = entry({
      id: 'msg-analyst-2',
      kind: 'tool_call',
      role: 'assistant',
      tool: 'list_cards',
      message_index: 2,
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [{
          id: 'functions.list_cards:0',
          type: 'function',
          function: { name: 'list_cards', arguments: '{}' },
        }],
      }),
    });
    const result = entry({
      id: 'msg-analyst-3',
      kind: 'tool_result',
      role: 'tool',
      tool: 'list_cards',
      tool_call_id: 'functions.list_cards:0',
      message_index: 3,
      content: JSON.stringify({ cards: [] }),
    });

    const timeline = entriesToTimeline([call, result], null);
    const pairs = timeline.rounds.flatMap((round) => round.toolPairs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].result).not.toBeNull();
    expect(pairs[0].status).toBe('ok');
  });

  it('still pairs entries that already carry top-level tool_call_id (forward-compatible path)', () => {
    const call = entry({
      id: 'msg-1',
      kind: 'tool_call',
      role: 'assistant',
      tool: 'list_cards',
      tool_call_id: 'call-abc',
      message_index: 1,
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [{ id: 'call-abc', type: 'function', function: { name: 'list_cards', arguments: '{}' } }],
      }),
    });
    const result = entry({
      id: 'msg-2',
      kind: 'tool_result',
      role: 'tool',
      tool: 'list_cards',
      tool_call_id: 'call-abc',
      message_index: 2,
      content: '{}',
    });
    const timeline = entriesToTimeline([call, result], null);
    const pairs = timeline.rounds.flatMap((round) => round.toolPairs);
    expect(pairs[0].status).toBe('ok');
  });

  it('marks tool_error results as error and leaves un-paired calls pending', () => {
    const call = entry({
      id: 'msg-a',
      kind: 'tool_call',
      role: 'assistant',
      tool_call_id: 'call-x',
      message_index: 1,
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [{ id: 'call-x', type: 'function', function: { name: 'list_cards', arguments: '{}' } }],
      }),
    });
    const errResult = entry({
      id: 'msg-b',
      kind: 'tool_error',
      role: 'tool',
      tool_call_id: 'call-x',
      message_index: 2,
      content: 'boom',
    });
    const lonely = entry({
      id: 'msg-c',
      kind: 'tool_call',
      role: 'assistant',
      message_index: 3,
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [{ id: 'call-y', type: 'function', function: { name: 'list_cards', arguments: '{}' } }],
      }),
    });
    const timeline = entriesToTimeline([call, errResult, lonely], null);
    const pairs = timeline.rounds.flatMap((round) => round.toolPairs);
    const byCall = new Map(pairs.map((p) => [p.call.id, p]));
    expect(byCall.get('msg-a')?.status).toBe('error');
    expect(byCall.get('msg-c')?.status).toBe('pending');
  });
});

describe('entriesToTimeline display filtering', () => {
  it('does not render raw activity-only rounds as visible transcript content', () => {
    const timeline = entriesToTimeline([
      entry({
        id: 'turn-started',
        role: 'system',
        kind: 'activity',
        content: JSON.stringify({ event: 'llm_turn_started' }),
        round_id: 'r-pre-0000000000000000000000000000000a',
      }),
    ], null);

    expect(timeline.rounds).toHaveLength(0);
    expect(timeline.activeRoundId).toBeNull();
  });

  it('does not render empty text-only rounds', () => {
    const timeline = entriesToTimeline([
      entry({
        id: 'empty-user',
        role: 'user',
        kind: 'text',
        content: '   ',
        round_id: 'r-user-0000000000000000000000000000000b',
      }),
    ], null);

    expect(timeline.rounds).toHaveLength(0);
    expect(timeline.activeRoundId).toBeNull();
  });

  it('keeps an otherwise empty active round visible when activity status is non-idle', () => {
    const timeline = entriesToTimeline([
      entry({
        id: 'turn-started',
        role: 'system',
        kind: 'activity',
        content: JSON.stringify({ event: 'llm_turn_started' }),
        round_id: 'r-assistant-0000000000000000000000000000000c',
      }),
    ], { status: 'thinking', pending_calls: [], updated_at: '2026-05-30T00:00:01Z' });

    expect(timeline.rounds).toHaveLength(1);
    expect(timeline.rounds[0].texts).toHaveLength(0);
    expect(timeline.rounds[0].activityStatus?.status).toBe('thinking');
    expect(timeline.activeRoundId).toBe(timeline.rounds[0].id);
  });
});
