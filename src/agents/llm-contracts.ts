import type { ToolDefinition } from '../contracts/index.js';
import type { CapabilityRequest } from './provider-capabilities.js';

export interface BuiltCandidateRequest {
  body: Record<string, unknown>;
  serializedBody: string;
  estimatedWireInputTokens: number;
  requestHash: string;
}

export interface LlmModelParams {
  temperature: number;
  max_tokens: number;
}

export interface LlmCompleteOptions extends LlmModelParams {
  inputId: string;
  signal?: AbortSignal;
  capabilityRequest?: CapabilityRequest;
  contract_id: string;
  contractName: string;
  terminalToolOffered: readonly string[];
  tools: ToolDefinition[];
  tool_choice: 'auto';
}
