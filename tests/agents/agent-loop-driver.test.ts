import { describe, it, expect } from '@jest/globals';
import { createAgentLoopDriver, type AgentLoopDriverIO, type VerifierRejectionEvent } from '../../src/agents/agent-loop-driver.js';
import { createContractVerifier } from '../../src/agents/contract-verifier.js';
import { createExecutorContract } from '../../src/contracts/executor-contract.js';
import type { ExecutorResultEnvelope } from '../../src/contracts/executor-envelope.js';
import type { ExecutorResult } from '../../src/contracts/agent-execution.js';
import type { LlmCompleteResult } from '../../src/agents/llm-contracts.js';

function makeIO(overrides: Partial<AgentLoopDriverIO<ExecutorResultEnvelope, ExecutorResult>> = {}): {
  io: AgentLoopDriverIO<ExecutorResultEnvelope, ExecutorResult>;
  log: { kind: string; payload?: unknown }[];
  rejections: VerifierRejectionEvent[];
} {
  const log: { kind: string; payload?: unknown }[] = [];
  const rejections: VerifierRejectionEvent[] = [];
  const contract = createExecutorContract();
  const verifier = createContractVerifier();
  const io: AgentLoopDriverIO<ExecutorResultEnvelope, ExecutorResult> = {
    contract,
    verifier,
    sessionId: 'sess-1',
    role: 'executor',
    attempt: 1,
    invokeTurn: async () => ({ kind: 'message', content: '' }) as LlmCompleteResult,
    persistAssistantToolCalls: (r) => { log.push({ kind: 'persistAssistantToolCalls', payload: r }); },
    persistAssistantText: (c) => { log.push({ kind: 'persistAssistantText', payload: c }); },
    executeActionToolCalls: async () => { log.push({ kind: 'executeActionToolCalls' }); },
    persistDuplicateDoneIgnored: (id, name) => { log.push({ kind: 'persistDuplicateDoneIgnored', payload: { id, name } }); },
    persistVerifiedDone: (id, name) => { log.push({ kind: 'persistVerifiedDone', payload: { id, name } }); },
    persistViolatedDone: (id, name, content) => { log.push({ kind: 'persistViolatedDone', payload: { id, name, content } }); },
    appendRepairMessage: (m) => { log.push({ kind: 'appendRepairMessage', payload: m }); },
    isCancelled: () => false,
    emitVerifierRejection: (e) => { rejections.push(e); },
    ...overrides,
  };
  return { io, log, rejections };
}

function toolCalls(tcs: { id: string; name: string; args: string }[]): LlmCompleteResult {
  return { kind: 'tool_calls', tool_calls: tcs.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } })) };
}

describe('agent-loop-driver', () => {
  it('succeeds on first turn when the agent emits a valid terminal call', async () => {
    const { io, log } = makeIO({
      invokeTurn: async () => toolCalls([{ id: 'tc-1', name: 'emit_executor_result', args: JSON.stringify({ status: 'done', status_text: 'ok', summary: 'ok', card_id: 'c1' }) }]),
    });
    const outcome = await createAgentLoopDriver(io).run();
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.terminalName).toBe('emit_executor_result');
    expect(outcome.result.status).toBe('done');
    expect(outcome.repairAttempts).toBe(0);
    expect(log.find((e) => e.kind === 'persistVerifiedDone')).toBeDefined();
    expect(log.some((e) => e.kind === 'appendRepairMessage')).toBe(false);
  });

  it('verifies-then-repairs on first violation, then succeeds on second turn', async () => {
    let turn = 0;
    const { io, log, rejections } = makeIO({
      invokeTurn: async () => {
        turn += 1;
        if (turn === 1) return toolCalls([{ id: 'tc-1', name: 'emit_executor_result', args: '{"status":"bogus"}' }]);
        return toolCalls([{ id: 'tc-2', name: 'emit_executor_result', args: JSON.stringify({ status: 'done', status_text: 'ok', summary: 'ok', card_id: 'c1' }) }]);
      },
    });
    const outcome = await createAgentLoopDriver(io).run();
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.repairAttempts).toBe(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toEqual(expect.objectContaining({ contract_id: 'executor', repair_round: 1, proposed_present: true }));
    const repairOrder = log.map((e) => e.kind);
    expect(repairOrder).toContain('persistViolatedDone');
    expect(repairOrder).toContain('appendRepairMessage');
    expect(log.find((e) => e.kind === 'persistViolatedDone')?.payload).toEqual({ id: 'tc-1', name: 'emit_executor_result', content: 'violated' });
  });

  it('keeps repairing invalid terminal calls until cancellation', async () => {
    let turns = 0;
    const { io, log, rejections } = makeIO({
      invokeTurn: async () => {
        turns += 1;
        return toolCalls([{ id: `tc-${turns}`, name: 'emit_executor_result', args: '{"status":"bogus"}' }]);
      },
      isCancelled: () => turns >= 3,
    });
    const outcome = await createAgentLoopDriver(io).run();
    expect(outcome).toEqual({ kind: 'cancelled', reason: 'abort' });
    expect(rejections).toHaveLength(3);
    const violated = log.filter((e) => e.kind === 'persistViolatedDone').map((e) => (e.payload as { content: string }).content);
    expect(violated).toEqual(['violated', 'violated', 'violated']);
  });

  it('keeps accepting non-terminal messages until cancellation', async () => {
    let turns = 0;
    const { io } = makeIO({
      invokeTurn: async () => {
        turns += 1;
        return { kind: 'message', content: 'thinking' } as LlmCompleteResult;
      },
      isCancelled: () => turns >= 3,
    });
    const outcome = await createAgentLoopDriver(io).run();
    expect(outcome).toEqual({ kind: 'cancelled', reason: 'abort' });
    expect(turns).toBe(3);
  });

  it('persists duplicate terminal calls as ignored and treats the first as canonical', async () => {
    const { io, log } = makeIO({
      invokeTurn: async () => toolCalls([
        { id: 'tc-1', name: 'emit_executor_result', args: JSON.stringify({ status: 'done', status_text: 'ok', summary: 'ok', card_id: 'c1' }) },
        { id: 'tc-2', name: 'emit_executor_result', args: JSON.stringify({ status: 'failed', status_text: 'fail' }) },
      ]),
    });
    const outcome = await createAgentLoopDriver(io).run();
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.result.status).toBe('done');
    const ignored = log.find((e) => e.kind === 'persistDuplicateDoneIgnored');
    expect(ignored?.payload).toEqual({ id: 'tc-2', name: 'emit_executor_result' });
  });

  it('cancels mid-loop when isCancelled flips true between turns', async () => {
    let cancelled = false;
    const { io } = makeIO({
      invokeTurn: async () => { cancelled = true; return { kind: 'message', content: '' } as LlmCompleteResult; },
      isCancelled: () => cancelled,
    });
    const outcome = await createAgentLoopDriver(io).run();
    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind !== 'cancelled') return;
    expect(outcome.reason).toBe('abort');
  });

  it('drains takeRuntimeDoneEnvelope source after a non-terminal tool-call turn', async () => {
    const runtimeEnvelope = { status: 'done', summary: 'queued', artifacts: [], attachments: [] } as unknown as ExecutorResultEnvelope;
    let drained = false;
    const { io } = makeIO({
      invokeTurn: async () => toolCalls([{ id: 'tc-1', name: 'read_file', args: '{}' }]),
      executeActionToolCalls: async () => {},
      takeRuntimeDoneEnvelope: () => {
        if (drained) return null;
        drained = true;
        return runtimeEnvelope;
      },
    });
    const outcome = await createAgentLoopDriver(io).run();
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.envelope).toBe(runtimeEnvelope);
  });

  it('drains runtime envelopes queued during a rejected terminal turn', async () => {
    const runtimeEnvelope = { status: 'done', summary: 'stale-runtime', artifacts: [], attachments: [] } as unknown as ExecutorResultEnvelope;
    let turn = 0;
    let queued: ExecutorResultEnvelope | null = null;
    const { io } = makeIO({
      invokeTurn: async () => {
        turn += 1;
        if (turn === 1) {
          return toolCalls([
            { id: 'tc-1', name: 'read_file', args: '{}' },
            { id: 'tc-2', name: 'emit_executor_result', args: '{"status":"bogus"}' },
          ]);
        }
        return toolCalls([{ id: 'tc-3', name: 'emit_executor_result', args: JSON.stringify({ status: 'done', status_text: 'ok', summary: 'terminal', card_id: 'c1' }) }]);
      },
      executeActionToolCalls: async () => {
        if (turn === 1) queued = runtimeEnvelope;
      },
      takeRuntimeDoneEnvelope: () => {
        const current = queued;
        queued = null;
        return current;
      },
    });

    const outcome = await createAgentLoopDriver(io).run();

    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.envelope).not.toBe(runtimeEnvelope);
    expect(outcome.result.summary).toBe('terminal');
  });
});
