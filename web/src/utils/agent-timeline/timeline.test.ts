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
  it('projects protocol tool results into the matching assistant call round for display', () => {
    const call = entry({
      id: 'turn-1:tool-call:call-a',
      kind: 'tool_call',
      role: 'assistant',
      tool: 'start_project',
      tool_call_id: 'call-a',
      round_id: 'r-assistant-000000000000000000000000000000aa',
      timestamp: '2026-05-30T00:00:02Z',
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'start_project', arguments: '{}' } }],
      }),
    });
    const result = entry({
      id: 'turn-2:tool-result:call-a',
      kind: 'tool_result',
      role: 'tool',
      tool: 'start_project',
      tool_call_id: 'call-a',
      round_id: 'r-user-000000000000000000000000000000bb',
      message_index: 2,
      timestamp: '2026-05-30T00:00:03Z',
      content: JSON.stringify({ success: true }),
    });

    const timeline = entriesToTimeline([call, result], null);

    expect(timeline.rounds).toHaveLength(1);
    expect(timeline.rounds[0].id).toBe(call.round_id);
    expect(timeline.rounds[0].toolPairs).toHaveLength(1);
    expect(timeline.rounds[0].toolPairs[0].result?.id).toBe(result.id);
  });

  it('keeps a projected tool result with the original call round position', () => {
    const before = entry({
      id: 'before-call',
      kind: 'text',
      content: 'before',
      round_id: 'r-user-00000000000000000000000000000001',
      message_index: 0,
      timestamp: '2026-05-30T00:00:01Z',
    });
    const call = entry({
      id: 'assistant-call',
      kind: 'tool_call',
      role: 'assistant',
      tool: 'read',
      tool_call_id: 'call-a',
      round_id: 'r-assistant-00000000000000000000000000000002',
      message_index: 1,
      timestamp: '2026-05-30T00:00:02Z',
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'read', arguments: '{}' } }],
      }),
    });
    const afterCall = entry({
      id: 'after-call',
      kind: 'text',
      content: 'after call before result',
      round_id: 'r-user-00000000000000000000000000000003',
      message_index: 0,
      timestamp: '2026-05-30T00:00:03Z',
    });
    const result = entry({
      id: 'later-result',
      kind: 'tool_result',
      role: 'tool',
      tool: 'read',
      tool_call_id: 'call-a',
      round_id: 'r-user-00000000000000000000000000000004',
      message_index: 2,
      timestamp: '2026-05-30T00:00:04Z',
      content: JSON.stringify({ ok: true }),
    });

    const timeline = entriesToTimeline([before, call, afterCall, result], null);

    expect(timeline.rounds.map((round) => round.id)).toEqual([before.round_id, call.round_id, afterCall.round_id]);
    expect(timeline.rounds[1].toolPairs[0].result?.id).toBe(result.id);
  });

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
  it('orders rounds by API input order instead of round-local message_index', () => {
    const repair = entry({
      id: 'old-repair',
      role: 'user',
      kind: 'model_repair',
      content: 'repair startup prompt',
      round_id: 'r-user-00000000000000000000000000000011',
      message_index: 3,
      timestamp: '2026-07-10T17:28:42.840Z',
    });
    const laterUser = entry({
      id: 'later-user',
      role: 'user',
      kind: 'text',
      content: 'later normal turn',
      round_id: 'r-user-00000000000000000000000000000022',
      message_index: 0,
      timestamp: '2026-07-10T18:00:00.000Z',
    });
    const laterAssistant = entry({
      id: 'later-assistant',
      role: 'assistant',
      kind: 'text',
      content: 'later answer',
      round_id: 'r-assistant-00000000000000000000000000000033',
      message_index: 1,
      timestamp: '2026-07-10T18:00:01.000Z',
    });

    const timeline = entriesToTimeline([repair, laterUser, laterAssistant], null);

    expect(timeline.rounds.map((round) => round.id)).toEqual([repair.round_id, laterUser.round_id, laterAssistant.round_id]);
  });

  it('does not move a later lower-message-index round before an earlier input round', () => {
    const earlier = entry({
      id: 'earlier-index-3',
      kind: 'text',
      content: 'earlier',
      round_id: 'r-user-00000000000000000000000000000044',
      message_index: 3,
    });
    const later = entry({
      id: 'later-index-0',
      kind: 'text',
      content: 'later',
      round_id: 'r-assistant-00000000000000000000000000000055',
      message_index: 0,
    });

    const timeline = entriesToTimeline([earlier, later], null);

    expect(timeline.rounds.map((round) => round.id)).toEqual([earlier.round_id, later.round_id]);
  });

  it('keeps system prompt, workspace context, and user rounds in API order when timestamps contradict it', () => {
    const context = entry({
      id: 'context',
      role: 'system',
      kind: 'text',
      content: '[workspace-context]',
      round_id: 'r-pre-00000000000000000000000000000011',
      message_index: 0,
      timestamp: '2026-05-30T00:00:01Z',
    });
    const user = entry({
      id: 'user',
      role: 'user',
      kind: 'text',
      content: 'launch the project',
      round_id: 'r-user-00000000000000000000000000000022',
      message_index: 1,
      timestamp: '2026-05-30T00:00:01Z',
    });
    const systemPrompt = entry({
      id: 'system-prompt',
      role: 'system',
      kind: 'system_prompt',
      content: 'system prompt',
      round_id: 'r-pre-00000000000000000000000000000033',
      message_index: 0,
      timestamp: '2026-05-30T00:00:03Z',
    });

    const timeline = entriesToTimeline([systemPrompt, context, user], null);

    expect(timeline.rounds.map((round) => round.id)).toEqual([systemPrompt.round_id, context.round_id, user.round_id]);
  });

  it('keeps same-timestamp rounds in API order instead of id order', () => {
    const context = entry({
      id: 'z-context',
      role: 'system',
      kind: 'text',
      content: '[workspace-context]',
      round_id: 'r-pre-00000000000000000000000000000066',
      message_index: 0,
      timestamp: '2026-05-30T00:00:01Z',
    });
    const user = entry({
      id: 'a-user',
      role: 'user',
      kind: 'text',
      content: 'launch the project',
      round_id: 'r-user-00000000000000000000000000000077',
      message_index: 0,
      timestamp: '2026-05-30T00:00:01Z',
    });

    const timeline = entriesToTimeline([context, user], null);

    expect(timeline.rounds.map((round) => round.id)).toEqual([context.round_id, user.round_id]);
  });

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

  it('does not synthesize tool calls for orphan tool results', () => {
    const orphanResult = entry({
      id: 'msg-orphan-result',
      kind: 'tool_result',
      role: 'tool',
      tool: 'read',
      tool_call_id: 'call-orphan-1',
      message_index: 2,
      content: JSON.stringify({ content: 'file contents' }),
    });

    const timeline = entriesToTimeline([orphanResult], null);
    const pairs = timeline.rounds.flatMap((round) => round.toolPairs);
    expect(pairs).toEqual([]);
  });
});
