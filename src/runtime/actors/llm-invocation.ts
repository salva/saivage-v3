import type { AgentMessage, OperationalAgentRole } from '../../schemas/index.js';
import type { ProviderTurnCompletion, ToolDefinition } from '../../agents/llm-contracts.js';
import type { CapabilityRequest } from '../../agents/provider-capabilities.js';

export interface LlmInvocationInput {
  inputId: string;
  agentId: string;
  role: OperationalAgentRole;
  sessionId: string;
  systemPrompt: string;
  contextMessages: unknown[];
  /**
   * Single-use conversation rows to append durably when this provider turn starts.
   * The LLM actor consumes them after a successful append and must not carry them
   * into tool or repair continuations; providers read contextMessages instead.
   */
  turnMessages?: AgentMessage[];
  tools: ToolDefinition[];
  terminalToolNames: string[];
  modelParams: { temperature?: number; maxTokens?: number };
  capabilityRequest: CapabilityRequest;
  episodeContext: Record<string, unknown>;
}

export interface ProviderTurnPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>;
}
