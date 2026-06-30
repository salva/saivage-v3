import { describe, expect, it } from 'vitest';

import type { AgentConversationEntry } from '../api/types';
import { entriesToTimeline } from '../utils/agent-timeline/timeline';

function entry(overrides: Partial<AgentConversationEntry>): AgentConversationEntry {
  return {
    id: 'entry-1',
    session_id: 'planner:card-1',
    role: 'system',
    kind: 'system_prompt',
    content: 'Plan and coordinate card card-1',
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
});
