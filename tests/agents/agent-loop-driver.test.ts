import { describe, it, expect } from '@jest/globals';
import { createAgentLoopDriver, type AgentLoopDriverIO, type VerifierRejectionEvent } from '../../src/agents/agent-loop-driver.js';
import { createContractVerifier } from '../../src/agents/contract-verifier.js';
import { createRepairBudget } from '../../src/agents/invocation-outcome.js';
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
  const contract = createExecutorContract({ cardId: 'c1', goalId: 'g1' });
  const verifier = createContractVerifier();
  const io: AgentLoopDriverIO<ExecutorResultEnvelope, ExecutorResult> = {
    contract,
    verifier,
    sessionId: 'sess-1',
    role: 'executor',
    attempt: 1,
    budget: createRepairBudget(1),
    maxToolTurns: 8,
    invokeTurn: async () => ({ kind: 'message', content: '' }) as LlmCompleteResult,
    persistAssistantToolCalls: (r) => { log.push({ kind: 'persistAssistantToolCalls', payload: r }); },
    persistAssistantText: (c) => { log.push({ kind: 'persistAssistantText', payload: c }); },
    executeActionToolCalls: async () => { log.push({ kind: 'executeActionToolCalls' }); return { runtimeSignalledDone: false }; },
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

  it('verifies-then-repairs on first violation, then succeeds on second turn (budget consumed)', async () => {
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
    expect(io.budget.consumed).toBe(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toEqual(expect.objectContaining({ contract_id: 'executor', repair_round: 1, proposed_present: true }));
    const repairOrder = log.map((e) => e.kind);
    expect(repairOrder).toContain('persistViolatedDone');
    expect(repairOrder).toContain('appendRepairMessage');
    expect(log.find((e) => e.kind === 'persistViolatedDone')?.payload).toEqual({ id: 'tc-1', name: 'emit_executor_result', content: 'violated' });
  });

  it('returns repair_exhausted after budget is consumed and the second attempt is still invalid', async () => {
    const { io, log, rejections } = makeIO({
      invokeTurn: async () => toolCalls([{ id: 'tc-x', name: 'emit_executor_result', args: '{"status":"bogus"}' }]),
    });
    const outcome = await createAgentLoopDriver(io).run();
    expect(outcome.kind).toBe('repair_exhausted');
    if (outcome.kind !== 'repair_exhausted') return;
    expect(outcome.repairAttempts).toBe(1);
    expect(outcome.lastReport.contractId).toBe('executor');
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    const violated = log.filter((e) => e.kind === 'persistViolatedDone').map((e) => (e.payload as { content: string }).content);
    expect(violated).toContain('violated');
    expect(violated).toContain('violated_exhausted');
  });

  it('returns no_progress when the agent keeps emitting non-terminal messages until maxToolTurns', async () => {
    const { io } = makeIO({
      maxToolTurns: 3,
      invokeTurn: async () => ({ kind: 'message', content: 'thinking' }) as LlmCompleteResult,
    });
    const outcome = await createAgentLoopDriver(io).run();
    expect(outcome.kind).toBe('no_progress');
    if (outcome.kind !== 'no_progress') return;
    expect(outcome.turnsConsumed).toBe(3);
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

  it('honors signalDoneFromRuntime: completes after the current turn with the runtime envelope', async () => {
    const runtimeEnvelope = { status: 'done', summary: 'from-runtime', artifacts: [], attachments: [] } as unknown as ExecutorResultEnvelope;
    const { io } = makeIO({
      invokeTurn: async () => ({ kind: 'message', content: '' }) as LlmCompleteResult,
    });
    const driver = createAgentLoopDriver(io);
    driver.signalDoneFromRuntime(runtimeEnvelope);
    const outcome = await driver.run();
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.envelope).toBe(runtimeEnvelope);
    expect(outcome.terminalName).toBe('emit_executor_result');
  });

  it('drains takeRuntimeDoneEnvelope source after a non-terminal tool-call turn', async () => {
    const runtimeEnvelope = { status: 'done', summary: 'queued', artifacts: [], attachments: [] } as unknown as ExecutorResultEnvelope;
    let drained = false;
    const { io } = makeIO({
      invokeTurn: async () => toolCalls([{ id: 'tc-1', name: 'read_file', args: '{}' }]),
      executeActionToolCalls: async () => ({ runtimeSignalledDone: true }),
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
});
