import { describe, expect, it } from 'vitest';

import type { AgentConversationEntry } from '../api/types';
import { entriesToTimeline } from '../utils/agent-timeline/timeline';

function entry(overrides: Partial<AgentConversationEntry>): AgentConversationEntry {
  return {
    id: 'entry-1',
    session_id: 'agent:planner:card-a',
    role: 'system',
    kind: 'system_prompt',
    content: 'Plan and coordinate card 11111111-1111-4111-8111-111111111111',
    round_id: 'r-pre-00000000000000000000000000000001',
    message_index: 0,
    block_index: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AgentConversationEntry;
}

describe('agent conversation timeline', () => {
  it('renders persisted system prompts as context text blocks', () => {
    const timeline = entriesToTimeline([entry({})], null);

    expect(timeline.rounds).toHaveLength(1);
    expect(timeline.rounds[0].texts).toEqual([expect.objectContaining({ kind: 'system_prompt' })]);
  });

  it('preserves API order for system prompt, context, and user rows despite contradictory timestamps and ids', () => {
    const systemPrompt = entry({
      id: 'z-system-prompt',
      kind: 'system_prompt',
      role: 'system',
      content: 'system prompt',
      round_id: 'r-pre-00000000000000000000000000000001',
      message_index: 0,
      timestamp: '2026-01-01T00:00:03.000Z',
    });
    const context = entry({
      id: 'm-context',
      kind: 'text',
      role: 'system',
      content: '[workspace-context]',
      round_id: 'r-pre-00000000000000000000000000000002',
      message_index: 0,
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    const user = entry({
      id: 'a-user',
      kind: 'text',
      role: 'user',
      content: 'Please inspect the current card.',
      round_id: 'r-user-00000000000000000000000000000003',
      message_index: 0,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    const timeline = entriesToTimeline([systemPrompt, context, user], null);

    expect(timeline.rounds.map((round) => round.id)).toEqual([systemPrompt.round_id, context.round_id, user.round_id]);
  });
});
