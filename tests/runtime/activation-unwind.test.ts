import { describe, expect, it, jest } from '@jest/globals';
import { buildParentPlannerActiveRun, findActivationCallerEdge, findUnresolvedActivateCardCalls, repairOrphanActivateCardToolCalls, selectChildGoalActivationOutcome, selectPendingActivationChildCardIds, selectTerminalActivationSynthesis } from '../../src/runtime/activation-unwind.js';
import { createActivationCompletionEnvelope } from '../../src/schemas/index.js';
import { serializeToolCallMessage } from '../../src/agents/persisted-tool-call.js';
import type { AgentMessage } from '../../src/schemas/types.js';

function message(overrides: Partial<AgentMessage>): AgentMessage {
  return {
    id: 'm1',
    session_id: 'planner:parent',
    role: 'assistant',
    kind: 'tool_call',
    content: '{}',
    round_id: 'r1',
    message_index: 0,
    block_index: 0,
    timestamp: 't0',
    ...overrides,
  } as AgentMessage;
}

function activateCall(id: string, cardId: string): AgentMessage {
  return message({ id: `m-${id}`, content: JSON.stringify(serializeToolCallMessage({ id, name: 'activate_card', args: { cardId } })) });
}

describe('activation unwind helpers', () => {
  it('reconstructs caller edge from card and session ports', () => {
    expect(findActivationCallerEdge({
      childCardId: 'child-a',
      cardPort: { getParent: () => 'goal-a' },
      sessionPort: {
        findPlannerSessionForCard: () => ({ id: 'planner:goal-a' }),
        findUniqueUnresolvedActivateCardToolCall: () => ({ tool_call_id: 'call-1' }),
      },
    })).toEqual({ parentCardId: 'goal-a', callerSessionId: 'planner:goal-a', callerToolCallId: 'call-1' });

    expect(findActivationCallerEdge({
      childCardId: 'child-a',
      cardPort: { getParent: () => null },
      sessionPort: { findPlannerSessionForCard: () => null, findUniqueUnresolvedActivateCardToolCall: () => null },
    })).toBeNull();
  });

  it('finds unresolved activate_card tool calls', () => {
    expect(findUnresolvedActivateCardCalls('planner:parent', [activateCall('call-1', 'child-a')])).toEqual([
      { session_id: 'planner:parent', tool_call_id: 'call-1', card_id: 'child-a' },
    ]);
  });

  it('treats terminal activation envelopes and tool errors as resolved', () => {
    const completion = createActivationCompletionEnvelope({
      child_card_id: 'child-a',
      outcome: 'done',
      summary: 'ok',
      result: null,
      review: null,
      artifacts: [],
      attachments: [],
      evidence_card_ids: ['child-a'],
      error: null,
      failure_kind: undefined,
    });
    expect(findUnresolvedActivateCardCalls('planner:parent', [
      activateCall('call-1', 'child-a'),
      message({ kind: 'tool_result', role: 'tool', tool_call_id: 'call-1', content: JSON.stringify(completion) }),
      activateCall('call-2', 'child-b'),
      message({ kind: 'tool_error', role: 'tool', tool_call_id: 'call-2', content: 'failed' }),
    ])).toEqual([]);
  });

  it('ignores malformed and non-activate tool calls', () => {
    expect(findUnresolvedActivateCardCalls('planner:parent', [
      message({ content: '{bad json' }),
      message({ content: JSON.stringify(serializeToolCallMessage({ id: 'call-1', name: 'read_card', args: { cardId: 'child-a' } })) }),
    ])).toEqual([]);
  });

  it('repairs unresolved activate_card calls only from planner sessions', () => {
    const synthesize = jest.fn((sessionId: string, toolCallId: string, cardId: string) => {
      void sessionId;
      void toolCallId;
      void cardId;
      return true;
    });
    repairOrphanActivateCardToolCalls({
      sessionPort: {
        listSessions: () => ['planner:parent', 'executor:child', 'missing'],
        getSession: (sessionId) => {
          if (sessionId === 'planner:parent') return { role: 'planner' };
          if (sessionId === 'executor:child') return { role: 'executor' };
          return null;
        },
        getSessionMessages: (sessionId) => sessionId === 'planner:parent'
          ? [activateCall('call-1', 'child-a')]
          : [activateCall('call-ignored', 'child-b')],
      },
      synthesizeTerminalActivationResult: synthesize,
    });

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith('planner:parent', 'call-1', 'child-a');
  });

  it('does not repair already resolved activate_card calls', () => {
    const completion = createActivationCompletionEnvelope({
      child_card_id: 'child-a',
      outcome: 'done',
      summary: 'ok',
      result: null,
      review: null,
      artifacts: [],
      attachments: [],
      evidence_card_ids: ['child-a'],
      error: null,
      failure_kind: undefined,
    });
    const synthesize = jest.fn((sessionId: string, toolCallId: string, cardId: string) => {
      void sessionId;
      void toolCallId;
      void cardId;
      return true;
    });
    repairOrphanActivateCardToolCalls({
      sessionPort: {
        listSessions: () => ['planner:parent'],
        getSession: () => ({ role: 'planner' }),
        getSessionMessages: () => [
          activateCall('call-1', 'child-a'),
          message({ kind: 'tool_result', role: 'tool', tool_call_id: 'call-1', content: JSON.stringify(completion) }),
        ],
      },
      synthesizeTerminalActivationResult: synthesize,
    });

    expect(synthesize).not.toHaveBeenCalled();
  });

  it('selects pending activation child ids for a parent in requested order', () => {
    expect(selectPendingActivationChildCardIds({
      status: 'idle',
      project_id: 'project',
      pid: 123,
      started_at: 't0',
      paused: false,
      paused_at: null,
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
      runtime_intent: { status: 'running', source_command_id: null, updated_at: 't0' },
      runtime_commands: [],
      runtime_runs: [],
      runtime_activations: [
        { activation_id: 'done', idempotency_key: 'k1', parent_card_id: 'parent', parent_run_id: 'run-parent', parent_session_id: 'planner:parent', parent_tool_call_id: 'call-1', child_card_id: 'done-child', status: 'completed', precondition: 'accepted', requested_at: 't1', updated_at: 't1', runtime_run_id: null, error: null },
        { activation_id: 'later', idempotency_key: 'k2', parent_card_id: 'parent', parent_run_id: 'run-parent', parent_session_id: 'planner:parent', parent_tool_call_id: 'call-2', child_card_id: 'later-child', status: 'pending', precondition: 'accepted', requested_at: 't2', updated_at: 't2', runtime_run_id: null, error: null },
        { activation_id: 'earlier', idempotency_key: 'k3', parent_card_id: 'parent', parent_run_id: 'run-parent', parent_session_id: 'planner:parent', parent_tool_call_id: 'call-3', child_card_id: 'earlier-child', status: 'running', precondition: 'accepted', requested_at: 't0', updated_at: 't0', runtime_run_id: null, error: null },
        { activation_id: 'other', idempotency_key: 'k4', parent_card_id: 'other', parent_run_id: 'run-other', parent_session_id: 'planner:other', parent_tool_call_id: 'call-4', child_card_id: 'other-child', status: 'pending', precondition: 'accepted', requested_at: 't0', updated_at: 't0', runtime_run_id: null, error: null },
      ],
      updated_at: 't0',
    }, 'parent')).toEqual(['earlier-child', 'later-child']);
  });

  it('selects child goal activation outcome from terminal status', () => {
    expect(selectChildGoalActivationOutcome({ status: 'done' } as any)).toBe('done');
    expect(selectChildGoalActivationOutcome({ status: 'blocked' } as any)).toBe('blocked');
    expect(selectChildGoalActivationOutcome({ status: 'cancelled' } as any)).toBe('cancelled');
    expect(selectChildGoalActivationOutcome({ status: 'failed' } as any)).toBe('failed');
    expect(selectChildGoalActivationOutcome(null)).toBe('failed');
  });

  it('selects terminal activation synthesis outcomes for restart repair', () => {
    expect(selectTerminalActivationSynthesis({ childCardId: 'child-a', card: { status: 'done' } as any })).toEqual({
      outcome: 'done',
      summary: "Restart repair delivered terminal status 'done' for card child-a.",
    });
    expect(selectTerminalActivationSynthesis({ childCardId: 'child-a', card: { status: 'cancelled' } as any })).toEqual({
      outcome: 'cancelled',
      summary: "Restart repair delivered terminal status 'cancelled' for card child-a.",
    });
    expect(selectTerminalActivationSynthesis({ childCardId: 'child-a', card: { status: 'failed' } as any })).toEqual({
      outcome: 'failed',
      summary: "Restart repair delivered terminal status 'failed' for card child-a.",
    });
    expect(selectTerminalActivationSynthesis({ childCardId: 'child-a', card: { status: 'blocked' } as any })).toBeNull();
    expect(selectTerminalActivationSynthesis({ childCardId: 'child-a', card: null })).toBeNull();
  });

  it('builds parent planner active runs from explicit inputs', () => {
    expect(buildParentPlannerActiveRun({
      parentCardId: 'goal-a',
      parent: { type: 'goal' } as any,
      at: '2026-01-01T00:00:00.000Z',
    })).toEqual({
      card_id: 'goal-a',
      card_type: 'goal',
      runtime_status: 'running',
      phase: 'planner',
      caller_session_id: null,
      caller_tool_call_id: null,
      planner_session_id: 'planner:goal-a',
      correction_attempts: 0,
      started_at: '2026-01-01T00:00:00.000Z',
      last_turn_at: '2026-01-01T00:00:00.000Z',
    });
  });
});
