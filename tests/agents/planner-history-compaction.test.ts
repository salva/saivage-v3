import { describe, expect, it } from '@jest/globals';
import type { AgentMessage, CardRecord } from '../../src/schemas/index.js';
import { ContextCompactor, prunePlannerCompletedInvocationHistory } from '../../src/agents/context-compactor.js';
import { buildPlannerStateContextMessage } from '../../src/agents/planner-state-context.js';

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

function card(input: Partial<CardRecord> & Pick<CardRecord, 'id' | 'type' | 'title'>): CardRecord {
  return {
    id: input.id,
    type: input.type,
    parent: input.parent ?? 'goal-1',
    depth: input.depth ?? 1,
    position: input.position ?? 0,
    title: input.title,
    description: input.description ?? '',
    status: input.status ?? 'backlog',
    tags: input.tags ?? [],
    priority: input.priority ?? 0,
    urgency: input.urgency ?? 'normal',
    created_by: input.created_by ?? 'planner',
    created_at: input.created_at ?? '2026-06-01T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-06-01T00:00:00.000Z',
    version_seq: input.version_seq ?? 1,
    depends_on: input.depends_on ?? [],
    related: input.related ?? [],
    acceptance: input.acceptance ?? '',
    lifecycle: input.lifecycle ?? ({ status: input.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle']),
    artifacts: input.artifacts ?? [],
    attachments: input.attachments ?? [],
    retries: input.retries ?? 0,
    status_text: input.status_text ?? null,
  };
}

function compactor(): ContextCompactor {
  return new ContextCompactor({
    saivageDir: '/no-such-saivage-dir',
    sessionStamper: {
      stampPre: () => ({ round_id: 'r-pre-00000000000000000000000000000000', message_index: 0, block_index: 0 }),
      stampUserMessage: () => ({ round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0 }),
      openAssistantRound: () => ({ round_id: 'r-assistant-00000000000000000000000000000000', message_index: 0, block_index: 0 }),
      stampInRound: () => ({ round_id: 'r-assistant-00000000000000000000000000000000', message_index: 0, block_index: 0 }),
      stampDiagnosticInCurrentRound: () => ({ round_id: 'r-diagnostic-00000000000000000000000000000000', message_index: 0, block_index: 0 }),
      stampCompacted: () => ({ round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0 }),
      closeRound: () => undefined,
      recordAppend: () => undefined,
    },
  });
}

describe('planner persisted history context compaction', () => {
  it('drops prior completed planner invocations from reusable model input', () => {
    const previousUser = message(1, 'old planning prompt');
    const previousTerminal = { ...message(2, JSON.stringify({ kind: 'result', payload: { status: 'blocked', summary: 'old blocked result' } })), role: 'assistant' as const };
    const resumeNote = { ...message(3, 'resume from current runtime state'), role: 'user' as const };

    const reusable = prunePlannerCompletedInvocationHistory([previousUser, previousTerminal, resumeNote]);

    expect(reusable).toEqual([resumeNote]);
  });

  it('uses only post-terminal planner history before compaction', () => {
    const previousTerminal = message(1, JSON.stringify({ kind: 'result', payload: { status: 'blocked', summary: 'old blocked result' } }));
    const current = message(2, 'current resume note');

    const compacted = compactor().compactPlannerInMemory(
      'planner:project',
      [message(0, 'old prompt'), previousTerminal, current],
      'planner',
      { contextLimit: 1, threshold: 1 },
      {
        projectRoot: '/no-such-project',
        goalId: 'goal-1',
        cardStore: { read: () => null, listChildren: () => [] },
        runtimeStateProvider: () => null,
      },
    );

    expect(compacted[0].content).toContain('original_message_count');
    expect(compacted[0].content).toContain('current resume note');
    expect(compacted[0].content).not.toContain('old blocked result');
  });

  it('replaces oversized planner history with a bounded metadata summary for model input', () => {
    const cards = new Map([
      ['goal-1', card({ id: 'goal-1', type: 'goal', parent: 'project', title: 'Goal one', status: 'running' })],
      ['architecture-1', card({ id: 'architecture-1', type: 'architecture', title: 'Design thing', status: 'done', position: 0 })],
      ['code-1', card({ id: 'code-1', type: 'code', title: 'Build thing', status: 'backlog', depends_on: ['architecture-1'], position: 1 })],
    ]);
    const bulkyMessages = Array.from({ length: 80 }, (_, index) =>
      message(index, `historical planner transcript ${index} ${'large-body '.repeat(1500)}`),
    );
    bulkyMessages.push(message(81, JSON.stringify({ cardId: 'child-a', long: 'x'.repeat(5000) }), 'tool_call'));

    const compacted = compactor().compactPlannerInMemory(
      'planner:project',
      bulkyMessages,
      'planner',
      { contextLimit: 24000, threshold: 1 },
      {
        projectRoot: '/no-such-project',
        goalId: 'goal-1',
        cardStore: {
          read: (id: string) => cards.get(id) ?? null,
          listChildren: () => ['architecture-1', 'code-1'],
        },
        runtimeStateProvider: () => null,
      },
    );

    expect(compacted).toHaveLength(18);
    expect(compacted[0].kind).toBe('context_compaction');
    expect(compacted[0].content).toContain('structured state message is authoritative');
    expect(compacted[0].content).not.toContain('authoritative goal context');
    expect(compacted[0].content).toContain('original_message_count');
    expect(compacted[0].content).not.toContain('context_source_policy');
    expect(compacted[0].content).toContain('recent_message_tail_preview');
    expect(compacted[1].role).toBe('user');
    expect(compacted[1].kind).toBe('text');
    expect(compacted[1].content).toContain('## Current Planner State');
    expect(compacted[1].content).toContain('direct_children');
    expect(compacted[1].content).toContain('do_not_recreate');
    expect(compacted[1].content).toContain('candidate_next_action');
    expect(compacted[1].content).toContain('activate_child');
    expect(compacted[1].content).toContain('Build thing (exists as code-1, backlog)');
    expect(compacted[0].content).not.toContain('large-body '.repeat(50));
    expect(compacted[0].content.length).toBeLessThan(12000);
    expect(compacted.slice(2)).toHaveLength(16);
    expect(compacted.at(-1)?.content).toContain('[truncated');
  });

  it('leaves non-planner and already-small histories unchanged', () => {
    const small = [message(1, 'small scheduler signal')];

    expect(compactor().compactPlannerInMemory('executor-1', small, 'executor', { contextLimit: 24000, threshold: 1 }, {
      projectRoot: '/no-such-project',
      goalId: 'goal-1',
      cardStore: { read: () => null, listChildren: () => [] },
      runtimeStateProvider: () => null,
    })).toBe(small);
    expect(compactor().compactPlannerInMemory('planner:project', small, 'planner', { contextLimit: 24000, threshold: 1 }, {
      projectRoot: '/no-such-project',
      goalId: 'goal-1',
      cardStore: { read: () => null, listChildren: () => [] },
      runtimeStateProvider: () => null,
    })).toBe(small);
  });

  it('summarizes role/kind counts and recent message snippets without full bodies', () => {
    const messages = [
      message(1, 'first ' + 'a'.repeat(1000)),
      message(2, 'second actionable scheduler signal'),
    ];

    const summary = compactor().compactPlannerInMemory('planner:project', messages, 'planner', { contextLimit: 1, threshold: 1 }, {
      projectRoot: '/no-such-project',
      goalId: 'goal-1',
      cardStore: { read: () => null, listChildren: () => [] },
      runtimeStateProvider: () => null,
    })[0];

    expect(summary.content).toContain('user/text');
    expect(summary.content).toContain('second actionable scheduler signal');
    expect(summary.content).toContain('[truncated');
    expect(summary.content).not.toContain('a'.repeat(500));
  });

  it('builds structured current planner state from authoritative card and runtime state', () => {
    const cards = new Map([
      ['goal-1', card({ id: 'goal-1', type: 'goal', parent: 'project', title: 'Goal one', status: 'running', acceptance: 'Goal accepted' })],
      ['architecture-1', card({ id: 'architecture-1', type: 'architecture', title: 'Design thing', status: 'done', position: 0, status_text: 'Complete' })],
      ['code-1', card({ id: 'code-1', type: 'code', title: 'Build thing', status: 'backlog', depends_on: ['architecture-1'], position: 1 })],
    ]);

    const state = buildPlannerStateContextMessage({
      projectRoot: '/no-such-project',
      sessionId: 'planner:goal-1',
      goalId: 'goal-1',
      cardStore: {
        read: (id: string) => cards.get(id) ?? null,
        listChildren: () => ['architecture-1', 'code-1'],
      },
      runtimeStateProvider: () => ({
        status: 'running',
        project_id: 'project',
        pid: 123,
        started_at: '2026-06-01T00:00:00.000Z',
        paused: false,
        updated_at: '2026-06-01T00:00:00.000Z',
        runtime_intent: { status: 'running', updated_at: '2026-06-01T00:00:00.000Z', source_command_id: null },
        active_card_run: null,
        runtime_runs: [{
          run_id: 'run-1',
          kind: 'child',
          ownership: { kind: 'activation', activation_id: 'act-test', parent_run_id: 'run-parent', parent_card_id: 'project', parent_session_id: 'planner:project', parent_tool_call_id: 'call-test' }, card_id: 'code-1',
          phase: 'executor',
          runtime_status: 'running',
          started_at: '2026-06-01T00:01:00.000Z',
          updated_at: '2026-06-01T00:01:00.000Z',
        }],
        runtime_commands: [],
        runtime_activations: [{
          activation_id: 'act-1',
          idempotency_key: 'key-1',
          parent_card_id: 'goal-1',
          parent_run_id: 'run-parent',
          parent_session_id: 'planner:goal-1',
          parent_tool_call_id: 'call-1',
          child_card_id: 'code-1',
          status: 'pending',
          requested_at: '2026-06-01T00:01:00.000Z',
          updated_at: '2026-06-01T00:01:00.000Z',
          precondition: 'accepted',
        }],
      }),
    });

    expect(state.role).toBe('user');
    expect(state.kind).toBe('text');
    expect(state.content).toContain('Goal accepted');
    expect(state.content).toContain('Design thing (exists as architecture-1, done)');
    expect(state.content).toContain('Build thing (exists as code-1, backlog)');
    expect(state.content).toContain('open_runs_for_goal');
    expect(state.content).toContain('unresolved_activations');
    expect(state.content).toContain('activate_child');
    expect(state.content).toContain('Existing direct children are authoritative');
  });
});
