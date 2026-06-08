import { describe, it, expect } from '@jest/globals';
import {
  extractDoneSignal,
  isTerminalState,
  onCancellation,
  onRepairAppended,
  onTurnEnd,
  onVerifierResult,
  type AgentLoopState,
} from '../../src/agents/agent-loop-state.js';
import { createExecutorContract } from '../../src/contracts/executor-contract.js';
import { createContractVerifier } from '../../src/agents/contract-verifier.js';
import type { ExecutorResultEnvelope } from '../../src/contracts/executor-envelope.js';
import type { LlmCompleteResult } from '../../src/agents/llm-contracts.js';

const contract = createExecutorContract();
const verifier = createContractVerifier();

function toolCallsResult(tcs: { id: string; name: string; args: string }[]): LlmCompleteResult {
  return {
    kind: 'tool_calls',
    tool_calls: tcs.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } })),
  };
}

describe('agent-loop-state', () => {
  describe('extractDoneSignal', () => {
    it('returns none for message results', () => {
      const ex = extractDoneSignal({ kind: 'message', content: 'hi' }, contract);
      expect(ex.found).toBe('none');
      expect(ex.duplicates).toEqual([]);
    });

    it('returns none when no tool call matches a terminal', () => {
      const ex = extractDoneSignal(toolCallsResult([{ id: 'tc-1', name: 'read_file', args: '{}' }]), contract);
      expect(ex.found).toBe('none');
    });

    it('returns the first matching terminal tool and collects later duplicates', () => {
      const ex = extractDoneSignal(
        toolCallsResult([
          { id: 'tc-1', name: 'read_file', args: '{}' },
          { id: 'tc-2', name: 'emit_executor_result', args: '{"status":"completed"}' },
          { id: 'tc-3', name: 'emit_executor_result', args: '{"status":"failed"}' },
        ]),
        contract,
      );
      expect(ex.found).toBe('tool');
      expect(ex.toolCallId).toBe('tc-2');
      expect(ex.toolName).toBe('emit_executor_result');
      expect(ex.rawArgs).toBe('{"status":"completed"}');
      expect(ex.duplicates).toEqual([{ toolCallId: 'tc-3', toolName: 'emit_executor_result' }]);
    });
  });

  describe('onTurnEnd', () => {
    it('transitions agent_turn → verifying when a pending done parse is supplied', () => {
      const start: AgentLoopState<ExecutorResultEnvelope> = { kind: 'agent_turn', turn: 0, repairAttempts: 0 };
      const pending = verifier.parseDoneArgs('tc-1', 'emit_executor_result', '{}');
      const next = onTurnEnd(start, pending);
      expect(next.kind).toBe('verifying');
      if (next.kind !== 'verifying') return;
      expect(next.turn).toBe(0);
      expect(next.proposed).toBe(pending);
    });

    it('increments turn when no pending parse and turn budget remains', () => {
      const next = onTurnEnd<ExecutorResultEnvelope>({ kind: 'agent_turn', turn: 1, repairAttempts: 0 }, null);
      expect(next).toEqual({ kind: 'agent_turn', turn: 2, repairAttempts: 0 });
    });

    it('continues incrementing turns without a software exhaustion cap', () => {
      const next = onTurnEnd<ExecutorResultEnvelope>({ kind: 'agent_turn', turn: 15, repairAttempts: 0 }, null);
      expect(next).toEqual({ kind: 'agent_turn', turn: 16, repairAttempts: 0 });
    });

    it('is a no-op when called from a non agent_turn state', () => {
      const start: AgentLoopState<ExecutorResultEnvelope> = { kind: 'cancelled', reason: 'abort' };
      expect(onTurnEnd(start, null)).toBe(start);
    });
  });

  describe('onVerifierResult', () => {
    const startVerifying: AgentLoopState<ExecutorResultEnvelope> = {
      kind: 'verifying',
      proposed: { kind: 'ok', toolCallId: 'tc-1', toolName: 'emit_executor_result', args: {} },
      turn: 0,
      repairAttempts: 0,
    };

    it('transitions verifying → done on satisfied', () => {
      const envelope = { status: 'done', artifacts: [], attachments: [], summary: 'ok' } as unknown as ExecutorResultEnvelope;
      const next = onVerifierResult(startVerifying, { kind: 'satisfied', envelope, terminalName: 'emit_executor_result' }, contract);
      expect(next.kind).toBe('done');
      if (next.kind !== 'done') return;
      expect(next.terminalName).toBe('emit_executor_result');
      expect(next.envelope).toBe(envelope);
    });

    it('transitions verifying → repairing for contract violations', () => {
      const report = { contractId: 'executor', toolName: 'emit_executor_result', proposed: {}, obligations: [{ code: 'envelope_schema_violation' as const, locator: 'status', description: 'bad' }] };
      const next = onVerifierResult(startVerifying, { kind: 'violated', report }, contract);
      expect(next.kind).toBe('repairing');
      if (next.kind !== 'repairing') return;
      expect(next.report).toBe(report);
      expect(next.toolCallId).toBe('tc-1');
      expect(next.repairAttempts).toBe(1);
    });
  });

  describe('onRepairAppended', () => {
    it('transitions repairing → agent_turn (turn+1)', () => {
      const next = onRepairAppended<ExecutorResultEnvelope>({ kind: 'repairing', report: { contractId: 'executor', toolName: 'emit_executor_result', proposed: {}, obligations: [] }, toolCallId: 'tc-1', turn: 2, repairAttempts: 1 });
      expect(next).toEqual({ kind: 'agent_turn', turn: 3, repairAttempts: 1 });
    });

    it('is a no-op from non-repairing states', () => {
      const s: AgentLoopState<ExecutorResultEnvelope> = { kind: 'agent_turn', turn: 0, repairAttempts: 0 };
      expect(onRepairAppended(s)).toBe(s);
    });
  });

  describe('onCancellation', () => {
    it('cancels active states with the given reason', () => {
      const next = onCancellation<ExecutorResultEnvelope>({ kind: 'agent_turn', turn: 0, repairAttempts: 0 }, 'timeout');
      expect(next).toEqual({ kind: 'cancelled', reason: 'timeout' });
    });

    it('does not overwrite already-terminal states', () => {
      const done: AgentLoopState<ExecutorResultEnvelope> = { kind: 'done', envelope: {} as ExecutorResultEnvelope, terminalName: 'emit_executor_result', repairAttempts: 0 };
      expect(onCancellation(done, 'abort')).toBe(done);
    });
  });

  describe('isTerminalState', () => {
    it('returns true exactly for done/cancelled', () => {
      expect(isTerminalState<ExecutorResultEnvelope>({ kind: 'agent_turn', turn: 0, repairAttempts: 0 })).toBe(false);
      expect(isTerminalState<ExecutorResultEnvelope>({ kind: 'verifying', proposed: { kind: 'ok', toolCallId: 'x', toolName: 'y', args: {} }, turn: 0, repairAttempts: 0 })).toBe(false);
      expect(isTerminalState<ExecutorResultEnvelope>({ kind: 'repairing', report: { contractId: 'c', toolName: 't', proposed: null, obligations: [] }, toolCallId: 'x', turn: 0, repairAttempts: 1 })).toBe(false);
      expect(isTerminalState<ExecutorResultEnvelope>({ kind: 'done', envelope: {} as ExecutorResultEnvelope, terminalName: 't', repairAttempts: 0 })).toBe(true);
      expect(isTerminalState<ExecutorResultEnvelope>({ kind: 'cancelled', reason: 'abort' })).toBe(true);
    });
  });
});
