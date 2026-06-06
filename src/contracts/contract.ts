import type { ZodTypeAny } from 'zod';
import type { PersistedToolCall } from './persisted-tool-call.js';

export interface ContractToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ContractTerminalDescriptor {
  name: string;
  description: string;
  schema: ZodTypeAny;
  toolDefinition: ContractToolDefinition;
}

export interface ContractViolation {
  code: 'terminal_tool_unexpected' | 'terminal_tool_invalid_envelope';
  message: string;
  locator: string;
}

export interface ContractVerifyOk<Envelope> {
  ok: true;
  terminalName: string;
  envelope: Envelope;
}

export interface ContractVerifyFail {
  ok: false;
  violation: ContractViolation;
}

export type ContractVerifyResult<Envelope> =
  | ContractVerifyOk<Envelope>
  | ContractVerifyFail;

export interface Contract<Envelope, TypedResult> {
  readonly name: string;
  readonly terminals: readonly ContractTerminalDescriptor[];
  describe(): string;
  isTerminalToolName(name: string): boolean;
  verify(call: PersistedToolCall): ContractVerifyResult<Envelope>;
  project(envelope: Envelope, terminalName: string): TypedResult;
}
