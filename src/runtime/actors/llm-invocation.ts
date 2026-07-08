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
  turnMessages?: AgentMessage[];
  tools: ToolDefinition[];
  terminalToolNames: string[];
  modelParams: { temperature?: number; maxTokens?: number };
  capabilityRequest: CapabilityRequest;
  episodeContext: Record<string, unknown>;
}

export interface ProviderTurnPort {
  completeTurn(input: LlmInvocationInput): Promise<ProviderTurnCompletion>;
}
