import type { LlmCompleteResult, ToolCall } from './llm-contracts.js';
import type { Contract } from '../contracts/contract.js';
import type {
  ContractCheckResult,
  DoneArgsParse,
  ObligationReport,
} from './contract-verifier.js';

/**
 * Explicit state machine for one agentFn invocation (per spec P-A2 §3.2).
 * Transitions are pure functions; I/O (LLM calls, persistence, event emission,
 * budget mutation) lives in the driver.
 */
export type AgentLoopState<Envelope> =
  | { kind: 'agent_turn'; turn: number; repairAttempts: number }
  | {
      kind: 'verifying';
      proposed: DoneArgsParse;
      turn: number;
      repairAttempts: number;
    }
  | {
      kind: 'repairing';
      report: ObligationReport;
      toolCallId: string;
      turn: number;
      repairAttempts: number;
    }
  | { kind: 'done'; envelope: Envelope; terminalName: string; repairAttempts: number }
  | { kind: 'cancelled'; reason: 'abort' | 'timeout' };

export interface DoneSignalExtraction {
  found: 'tool' | 'none';
  toolCallId?: string;
  toolName?: string;
  rawArgs?: string;
  duplicates: { toolCallId: string; toolName: string }[];
}

export function extractDoneSignal<Envelope, TypedResult>(
  result: LlmCompleteResult,
  contract: Contract<Envelope, TypedResult>,
): DoneSignalExtraction {
  if (result.kind !== 'tool_calls') return { found: 'none', duplicates: [] };
  let first: ToolCall | null = null;
  const duplicates: { toolCallId: string; toolName: string }[] = [];
  for (const tc of result.tool_calls) {
    if (!contract.isTerminalToolName(tc.function.name)) continue;
    if (first === null) {
      first = tc;
    } else {
      duplicates.push({ toolCallId: tc.id, toolName: tc.function.name });
    }
  }
  if (first === null) return { found: 'none', duplicates };
  return {
    found: 'tool',
    toolCallId: first.id,
    toolName: first.function.name,
    rawArgs: first.function.arguments,
    duplicates,
  };
}

/** Transition: arrived at the end of the tool-call loop for this turn. */
export function onTurnEnd<Envelope>(
  state: AgentLoopState<Envelope>,
  pending: DoneArgsParse | null,
): AgentLoopState<Envelope> {
  if (state.kind !== 'agent_turn') return state;
  if (pending !== null) {
    return { kind: 'verifying', proposed: pending, turn: state.turn, repairAttempts: state.repairAttempts };
  }
  const nextTurn = state.turn + 1;
  return { kind: 'agent_turn', turn: nextTurn, repairAttempts: state.repairAttempts };
}

/** Transition: the verifier produced a verdict. Pure; budget is mutated by the driver. */
export function onVerifierResult<Envelope, TypedResult>(
  state: AgentLoopState<Envelope>,
  check: ContractCheckResult<Envelope>,
  _contract: Contract<Envelope, TypedResult>,
): AgentLoopState<Envelope> {
  if (state.kind !== 'verifying') return state;
  if (check.kind === 'satisfied') {
    return {
      kind: 'done',
      envelope: check.envelope,
      terminalName: check.terminalName,
      repairAttempts: state.repairAttempts,
    };
  }
  const toolCallId =
    state.proposed.kind === 'invalid_json' ? state.proposed.toolCallId : state.proposed.toolCallId;
  return {
    kind: 'repairing',
    report: check.report,
    toolCallId,
    turn: state.turn,
    repairAttempts: state.repairAttempts + 1,
  };
}

/** Transition: a repair message has been appended; resume the next agent turn. */
export function onRepairAppended<Envelope>(
  state: AgentLoopState<Envelope>,
): AgentLoopState<Envelope> {
  if (state.kind !== 'repairing') return state;
  return { kind: 'agent_turn', turn: state.turn + 1, repairAttempts: state.repairAttempts };
}

export function onCancellation<Envelope>(
  state: AgentLoopState<Envelope>,
  reason: 'abort' | 'timeout',
): AgentLoopState<Envelope> {
  if (
    state.kind === 'done' ||
    state.kind === 'cancelled'
  ) {
    return state;
  }
  return { kind: 'cancelled', reason };
}

export function isTerminalState<Envelope>(state: AgentLoopState<Envelope>): boolean {
  return (
    state.kind === 'done' ||
    state.kind === 'cancelled'
  );
}
