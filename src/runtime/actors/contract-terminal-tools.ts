import type { Contract } from '../../contracts/contract.js';
import type { PersistedToolCall } from '../../contracts/persisted-tool-call.js';
import type { LLMActorOutcome } from './llm-actor.js';

export type VerifiedTerminalTool<Envelope, TypedResult> = {
  terminalName: string;
  envelope: Envelope;
  result: TypedResult;
};

export function verifyTerminalToolOutcome<Envelope, TypedResult>(
  contract: Contract<Envelope, TypedResult>,
  outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>,
): VerifiedTerminalTool<Envelope, TypedResult> {
  if (!contract.isTerminalToolName(outcome.toolName)) {
    throw new Error(`Expected terminal tool ${terminalNames(contract)}, received '${outcome.toolName}'.`);
  }
  if (!outcome.args || typeof outcome.args !== 'object' || Array.isArray(outcome.args)) {
    throw new Error(`Terminal tool '${outcome.toolName}' arguments must be a JSON object.`);
  }
  const call: PersistedToolCall = {
    id: outcome.toolCallId,
    name: outcome.toolName,
    args: outcome.args as Record<string, unknown>,
  };
  const verified = contract.verify(call);
  if (!verified.ok) throw new Error(verified.violation.message);
  return {
    terminalName: verified.terminalName,
    envelope: verified.envelope,
    result: contract.project(verified.envelope, verified.terminalName),
  };
}

export function expectedTerminalToolMessage(contract: Contract<unknown, unknown>): string {
  return `Expected terminal tool ${terminalNames(contract)}.`;
}

function terminalNames(contract: Contract<unknown, unknown>): string {
  return contract.terminals.map((terminal) => `'${terminal.name}'`).join(', ');
}
