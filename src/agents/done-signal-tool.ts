import type { Contract, ContractToolDefinition } from '../contracts/contract.js';

/**
 * Per-invocation done-signal tools derived from the active contract's terminals.
 * Each terminal descriptor already carries its own JSON-Schema `toolDefinition`;
 * the driver appends these alongside the role's regular action tools.
 */
export function buildDoneSignalTools<Envelope, TypedResult>(
  contract: Contract<Envelope, TypedResult>,
): ContractToolDefinition[] {
  return contract.terminals.map((t) => t.toolDefinition);
}

export function isDoneSignalToolName<Envelope, TypedResult>(
  contract: Contract<Envelope, TypedResult>,
  name: string,
): boolean {
  return contract.isTerminalToolName(name);
}
