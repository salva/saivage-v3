import type { Contract } from '../contracts/contract.js';
import type { ContractVerifier, ObligationReport } from './contract-verifier.js';
import type { LlmCompleteResult } from './llm-contracts.js';
import {
  type AgentLoopState,
  extractDoneSignal,
  isTerminalState,
  onCancellation,
  onRepairAppended,
  onTurnEnd,
  onVerifierResult,
} from './agent-loop-state.js';
import type { InvocationOutcomeOf, RepairBudget } from './invocation-outcome.js';
import { createRepairBudget } from './invocation-outcome.js';

/**
 * VerifierRejectionEvent payload emitted whenever the verifier rejects a
 * candidate envelope. Wired to the event bus in Step 4 (registered as
 * `llm_verifier_rejection`); the driver only needs a typed sink in Step 1.
 */
export interface VerifierRejectionEvent {
  session_id: string;
  role: string;
  attempt: number;
  repair_round: number;
  obligation_codes: string[];
  proposed_present: boolean;
  contract_id: string;
}

export interface AgentLoopDriverIO<Envelope, TypedResult> {
  contract: Contract<Envelope, TypedResult>;
  verifier: ContractVerifier;
  sessionId: string;
  role: string;
  attempt: number;
  budget: RepairBudget;
  maxToolTurns: number;
  /** Perform one LLM turn (tool-call invocation). The driver decides what to do with the result. */
  invokeTurn: (turn: number) => Promise<LlmCompleteResult>;
  /** Persist all assistant tool_call rows from the result (one per row). */
  persistAssistantToolCalls: (result: LlmCompleteResult) => Promise<void> | void;
  /** Persist a plain assistant text message (no tool calls returned). */
  persistAssistantText: (content: string) => Promise<void> | void;
  /** Execute non-terminal action tool calls and persist their tool results; returns true if any tool produced an external signalDoneFromRuntime envelope. */
  executeActionToolCalls: (result: LlmCompleteResult) => Promise<{ runtimeSignalledDone: boolean }>;
  /** Persist a `tool_result` row marking duplicate terminal calls as ignored. */
  persistDuplicateDoneIgnored: (toolCallId: string, toolName: string) => Promise<void> | void;
  /** Persist a `tool_result` row for the verified terminal call. */
  persistVerifiedDone: (toolCallId: string, toolName: string) => Promise<void> | void;
  /** Persist a `tool_result` row for a violated terminal call (single attempt). */
  persistViolatedDone: (toolCallId: string, toolName: string, content: 'violated' | 'violated_exhausted') => Promise<void> | void;
  /** Append a `model_repair` system message rendered from the obligation report. */
  appendRepairMessage: (message: string) => Promise<void> | void;
  /** Return true if the session was cancelled externally. */
  isCancelled: () => boolean;
  /** Optional sink for verifier-rejection diagnostics. */
  emitVerifierRejection?: (event: VerifierRejectionEvent) => void;
  /** Optional source of a runtime-signalled done envelope (e.g. planner deferred-activate). */
  takeRuntimeDoneEnvelope?: () => Envelope | null;
}

export interface AgentLoopDriver<Envelope, TypedResult> {
  run(): Promise<InvocationOutcomeOf<Envelope, TypedResult>>;
  /** Externally signal that the runtime has produced a terminal envelope mid-loop. */
  signalDoneFromRuntime(envelope: Envelope): void;
}

export function createAgentLoopDriver<Envelope, TypedResult>(
  io: AgentLoopDriverIO<Envelope, TypedResult>,
): AgentLoopDriver<Envelope, TypedResult> {
  let runtimeDoneEnvelope: Envelope | null = null;
  let state: AgentLoopState<Envelope> = { kind: 'agent_turn', turn: 0, repairAttempts: 0 };

  function takeRuntimeDone(): Envelope | null {
    if (runtimeDoneEnvelope !== null) {
      const e = runtimeDoneEnvelope;
      runtimeDoneEnvelope = null;
      return e;
    }
    if (io.takeRuntimeDoneEnvelope) return io.takeRuntimeDoneEnvelope();
    return null;
  }

  function lastReportFromState(s: AgentLoopState<Envelope>): ObligationReport | null {
    return s.kind === 'repair_exhausted' ? s.lastReport : null;
  }

  async function run(): Promise<InvocationOutcomeOf<Envelope, TypedResult>> {
    while (!isTerminalState(state)) {
      if (io.isCancelled()) {
        state = onCancellation(state, 'abort');
        break;
      }
      if (state.kind !== 'agent_turn') break;

      const result = await io.invokeTurn(state.turn);

      // Detect runtime-supplied done envelope (planner deferred-activate path).
      const runtimeDone = takeRuntimeDone();
      if (runtimeDone !== null) {
        await io.persistAssistantToolCalls(result);
        await io.executeActionToolCalls(result);
        state = {
          kind: 'done',
          envelope: runtimeDone,
          terminalName: io.contract.terminals[0]?.name ?? '<runtime>',
          repairAttempts: state.repairAttempts,
        };
        break;
      }

      if (result.kind === 'message') {
        if (result.content && result.content.length > 0) {
          await io.persistAssistantText(result.content);
        }
        state = onTurnEnd(state, null, io.maxToolTurns);
        continue;
      }

      // tool_calls path
      await io.persistAssistantToolCalls(result);
      const extraction = extractDoneSignal(result, io.contract);
      for (const dup of extraction.duplicates) {
        await io.persistDuplicateDoneIgnored(dup.toolCallId, dup.toolName);
      }

      if (extraction.found === 'none') {
        await io.executeActionToolCalls(result);
        const runtimeDoneAfter = takeRuntimeDone();
        if (runtimeDoneAfter !== null) {
          state = {
            kind: 'done',
            envelope: runtimeDoneAfter,
            terminalName: io.contract.terminals[0]?.name ?? '<runtime>',
            repairAttempts: state.repairAttempts,
          };
          break;
        }
        state = onTurnEnd(state, null, io.maxToolTurns);
        continue;
      }

      // Execute non-terminal action tools alongside the terminal call.
      await io.executeActionToolCalls(result);
      // A mixed terminal + runtime-signalled turn must not carry a stale runtime envelope into a later repair turn.
      takeRuntimeDone();

      const parse = io.verifier.parseDoneArgs(
        extraction.toolCallId!,
        extraction.toolName!,
        extraction.rawArgs ?? '',
      );
      state = { kind: 'verifying', proposed: parse, turn: state.turn, repairAttempts: state.repairAttempts };
      const verdict = io.verifier.check(io.contract, parse);
      const nextState = onVerifierResult(state, verdict, io.budget, io.contract, io.maxToolTurns);

      if (verdict.kind === 'satisfied') {
        await io.persistVerifiedDone(extraction.toolCallId!, extraction.toolName!);
        state = nextState;
        break;
      }

      // verdict.kind === 'violated'
      const exhausted = nextState.kind === 'repair_exhausted' || nextState.kind === 'no_progress';
      await io.persistViolatedDone(
        extraction.toolCallId!,
        extraction.toolName!,
        exhausted ? 'violated_exhausted' : 'violated',
      );
      if (io.emitVerifierRejection) {
        io.emitVerifierRejection({
          session_id: io.sessionId,
          role: io.role,
          attempt: io.attempt,
          repair_round: state.repairAttempts + 1,
          obligation_codes: verdict.report.obligations.map((o) => o.code),
          proposed_present: verdict.report.proposed !== null,
          contract_id: io.contract.name,
        });
      }
      if (!exhausted) {
        io.budget.consumed += 1;
        const message = io.verifier.renderRepairMessage(verdict.report);
        await io.appendRepairMessage(message);
        state = onRepairAppended(nextState);
        continue;
      }
      state = nextState;
      break;
    }

    switch (state.kind) {
      case 'done':
        return {
          kind: 'succeeded',
          envelope: state.envelope,
          result: io.contract.project(state.envelope, state.terminalName),
          terminalName: state.terminalName,
          repairAttempts: state.repairAttempts,
        };
      case 'repair_exhausted':
        return {
          kind: 'repair_exhausted',
          lastReport: state.lastReport,
          repairAttempts: state.repairAttempts,
        };
      case 'no_progress': {
        const last = lastReportFromState(state);
        if (last) {
          return { kind: 'repair_exhausted', lastReport: last, repairAttempts: state.repairAttempts };
        }
        return {
          kind: 'no_progress',
          turnsConsumed: state.turnsConsumed,
          repairAttempts: state.repairAttempts,
        };
      }
      case 'cancelled':
        return { kind: 'cancelled', reason: state.reason };
      default:
        return {
          kind: 'no_progress',
          turnsConsumed: io.maxToolTurns,
          repairAttempts: 0,
        };
    }
  }

  return {
    run,
    signalDoneFromRuntime(envelope) {
      runtimeDoneEnvelope = envelope;
    },
  };
}

export { createRepairBudget };
