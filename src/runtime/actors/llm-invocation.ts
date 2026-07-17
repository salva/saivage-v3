import type { AgentMessage, OperationalAgentRole } from '../../schemas/index.js';
import type { ProviderConversationProjection, ProviderTurnCompletion, ToolDefinition } from '../../agents/llm-contracts.js';
import type { CapabilityRequest } from '../../agents/provider-capabilities.js';

export type PreparedCompaction = {
  readonly inputBudgetTokens: number;
  readonly requestedCompletionTokens: number;
  readonly triggerLineTokens: number;
  readonly estimatedStaticTokens: number;
  readonly triggerMessageThreshold: number;
  readonly canonicalMessageHardCeiling: number;
  readonly normalTailBudget: number;
  readonly normalMiddleBudget: number;
  readonly escalatedTailBudget: number;
  readonly escalatedMiddleBudget: number;
  readonly triggerFraction: number;
  readonly completionReserveFraction: number;
  readonly normalMergeLineFraction: number;
  readonly normalSummaryLineFraction: number;
  readonly escalatedMergeLineFraction: number;
  readonly escalatedSummaryLineFraction: number;
  readonly snap: 'keep_straddler_verbatim' | 'compact_straddler';
  readonly summarizerModel: string;
};

interface LlmInvocationInputBase {
  inputId: string;
  agentId: string;
  role: OperationalAgentRole;
  /** Invocation/persistence owner. Ordinary actor turns require this to equal providerConversation.sourceSessionId. */
  sessionId: string;
  systemPrompt: string;
  /** Current provider-eligible rows from one source-identified validated conversation. */
  providerConversation: ProviderConversationProjection;
  /**
   * Single-use conversation rows to append durably when this provider turn starts.
   * The LLM actor consumes them after a successful append and must not carry them
   * into tool or repair continuations; providers read the explicit projections instead.
   */
  turnMessages?: AgentMessage[];
  tools: ToolDefinition[];
  terminalToolNames: string[];
  capabilityRequest: CapabilityRequest;
  episodeContext: Record<string, unknown>;
}

export type LlmInvocationInput = LlmInvocationInputBase & (
  | { preparedCompaction: PreparedCompaction; modelParams: { temperature?: number; maxTokens?: never } }
  | { preparedCompaction?: never; modelParams: { temperature?: number; maxTokens?: number } }
);

export interface ProviderTurnPort {
  completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>;
}
