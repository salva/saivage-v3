import type { AgentName, ConversationSessionId } from '../../schemas/index.js';
import type { ProviderConversationProjection, ToolDefinition } from '../../agents/llm-contracts.js';
import type { CapabilityRequest } from '../../agents/provider-capabilities.js';
import type { Candidate } from '../../contracts/provider-candidate.js';

export type PreparedCompaction = {
  readonly inputBudgetTokens: number;
  readonly reservedCompletionTokens: number;
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
};

export type InvocationRoutePass =
  | { kind: 'ordinary'; candidateChain: readonly Candidate[] }
  | { kind: 'pinned-content-policy-retry'; candidate: Candidate };

interface LlmInvocationInputBase {
  inputId: string;
  agentId: string;
  agentName: AgentName;
  /** Invocation/persistence owner. Ordinary actor turns require this to equal providerConversation.sourceSessionId. */
  sessionId: string;
  systemPrompt: string;
  /** Current provider-eligible rows from one source-identified validated canonical conversation. */
  providerConversation: ProviderConversationProjection;
  tools: ToolDefinition[];
  terminalToolNames: string[];
  capabilityRequest: CapabilityRequest;
  episodeContext: Record<string, unknown>;
  routePass: InvocationRoutePass;
}

export type LlmInvocationInput = LlmInvocationInputBase & (
  | { preparedCompaction: PreparedCompaction; modelParams: { temperature?: number; maxTokens?: never } }
  | { preparedCompaction?: never; modelParams: { temperature?: number; maxTokens?: number } }
);

export type CanonicalLlmInvocationInput = LlmInvocationInput & { sessionId: ConversationSessionId };
export type PreparedLlmInvocationInput = Extract<CanonicalLlmInvocationInput, { preparedCompaction: PreparedCompaction }>;
