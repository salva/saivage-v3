import { describe, expect, it } from '@jest/globals';
import type { AgentMessage } from '../../src/schemas/index.js';
import {
  buildPlannerCompactionSourceDecisions,
  buildPlannerHistoryCompactionMessage,
  compactPlannerModelMessagesForContext,
} from '../../src/agents/agent-adapter.js';

function message(index: number, content: string, kind: AgentMessage['kind'] = 'text'): AgentMessage {
  return {
    id: `msg-${index}`,
    session_id: 'planner:project',
    role: index % 2 === 0 ? 'user' : 'assistant',
    kind,
    content,
    round_id: `round-${index}`,
    message_index: index,
    block_index: index,
    timestamp: `2026-06-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
  };
}

describe('planner persisted history context compaction', () => {
  it('replaces oversized planner history with a bounded metadata summary for model input', () => {
    const bulkyMessages = Array.from({ length: 80 }, (_, index) =>
      message(index, `historical planner transcript ${index} ${'large-body '.repeat(1500)}`),
    );
    bulkyMessages.push(message(81, JSON.stringify({ cardId: 'child-a', long: 'x'.repeat(5000) }), 'tool_call'));

    const compacted = compactPlannerModelMessagesForContext(
      'planner:project',
      bulkyMessages,
      'planner',
    );

    expect(compacted).toHaveLength(1);
    expect(compacted[0].kind).toBe('context_compaction');
    expect(compacted[0].content).toContain('authoritative goal context');
    expect(compacted[0].content).toContain('original_message_count');
    expect(compacted[0].content).toContain('context_source_policy');
    expect(compacted[0].content).toContain('system_prompt');
    expect(compacted[0].content).toContain('active_card');
    expect(compacted[0].content).toContain('selected_skills');
    expect(compacted[0].content).toContain('recent_message_summaries');
    expect(compacted[0].content).toContain('tool_call content omitted');
    expect(compacted[0].content).not.toContain('large-body '.repeat(50));
    expect(compacted[0].content.length).toBeLessThan(12000);
  });

  it('leaves non-planner and already-small histories unchanged', () => {
    const small = [message(1, 'small scheduler signal')];

    expect(compactPlannerModelMessagesForContext('executor-1', small, 'executor')).toBe(small);
    expect(compactPlannerModelMessagesForContext('planner:project', small, 'planner')).toBe(small);
  });

  it('summarizes role/kind counts and recent message snippets without full bodies', () => {
    const messages = [
      message(1, 'first ' + 'a'.repeat(1000)),
      message(2, 'second actionable scheduler signal'),
    ];

    const summary = buildPlannerHistoryCompactionMessage('planner:project', messages, {
      selectedSkillsIncluded: true,
    });

    expect(summary.content).toContain('user/text');
    expect(summary.content).toContain('second actionable scheduler signal');
    expect(summary.content).toContain('include_rendered');
    expect(summary.content).toContain('[truncated');
    expect(summary.content).not.toContain('a'.repeat(500));
  });

  it('keeps explicit source policy for authoritative prompt/card inputs versus transcript history', () => {
    const decisions = buildPlannerCompactionSourceDecisions({
      systemPromptIncluded: true,
      activeCardIncluded: true,
      directChildrenIncluded: true,
      runtimeLedgerIncluded: true,
      toolContractIncluded: true,
      selectedSkillsIncluded: false,
    });

    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'system_prompt', policy: 'include_rendered' }),
      expect.objectContaining({ source: 'active_card', policy: 'include_rendered' }),
      expect.objectContaining({ source: 'direct_children', policy: 'include_rendered' }),
      expect.objectContaining({ source: 'runtime_ledger', policy: 'include_summary' }),
      expect.objectContaining({ source: 'tool_contract', policy: 'include_rendered' }),
      expect.objectContaining({ source: 'selected_skills', policy: 'include_reference' }),
      expect.objectContaining({ source: 'transcript_body', policy: 'exclude' }),
    ]));
  });
});
