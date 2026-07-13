import type { AgentMessage, OperationalAgentRole } from '../../schemas/index.js';
import type { ProviderTurnCompletion, ResponsesReplayProjection, ToolDefinition } from '../../agents/llm-contracts.js';
import type { CapabilityRequest } from '../../agents/provider-capabilities.js';
import type { MutationAuthority } from '../../application/mutation-authority.js';

export interface LlmInvocationInput {
  inputId: string;
  agentId: string;
  role: OperationalAgentRole;
  sessionId: string;
  systemPrompt: string;
  genericContextMessages?: AgentMessage[];
  activeConversationReplay?: ResponsesReplayProjection;
  contextMessages: unknown[];
  /**
   * Single-use conversation rows to append durably when this provider turn starts.
   * The LLM actor consumes them after a successful append and must not carry them
   * into tool or repair continuations; providers read the explicit projections instead.
   */
  turnMessages?: AgentMessage[];
  tools: ToolDefinition[];
  terminalToolNames: string[];
  modelParams: { temperature?: number; maxTokens?: number };
  capabilityRequest: CapabilityRequest;
  episodeContext: Record<string, unknown>;
}

export interface ProviderTurnPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal, mutationAuthority: MutationAuthority): Promise<ProviderTurnCompletion>;
}

export function genericContextMessagesForInvocation(input: LlmInvocationInput): AgentMessage[] {
  const messages = input.genericContextMessages ?? input.contextMessages as AgentMessage[];
  if (!messages) throw new Error(`LLM invocation '${input.inputId}' is missing genericContextMessages.`);
  return messages;
}

export function activeConversationReplayForInvocation(input: LlmInvocationInput): ResponsesReplayProjection {
  if (!input.activeConversationReplay) throw new Error(`LLM invocation '${input.inputId}' is missing activeConversationReplay.`);
  return input.activeConversationReplay;
}
