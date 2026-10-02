import type { Candidate } from './provider-candidate.js';
import type { ToolDefinition } from './provider-turn.js';
import type {
  ContextAudience,
  ContextEvidence,
  ContextReplacement,
  ToolResultPolicyTemplate,
} from '../schemas/index.js';

export type PreparedCompaction = {
  readonly routeUsableInputTokens: number;
  readonly requestedCompletionTokens: number;
  readonly triggerLineTokens: number;
  readonly estimatedStaticTokens: number;
  readonly triggerMessageThreshold: number;
  readonly canonicalMessageHardCeiling: number;
  readonly tailBudgetTokens: number;
  readonly triggerFraction: number;
  readonly contextUtilizationFraction: number;
  readonly tailFraction: number;
  readonly snap: 'keep_straddler_verbatim' | 'compact_straddler';
};

export type InvocationRoutePass =
  | { kind: 'ordinary'; candidateChain: readonly Candidate[] }
  | { kind: 'pinned-content-policy-retry'; candidate: Candidate };

type ContextStorage = 'durable' | 'activation_local';
export type ContextBlock = Readonly<{
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  storage: ContextStorage;
  replacement: ContextReplacement;
  audience: ContextAudience;
  evidence: ContextEvidence;
}>;

export type ProviderToolDefinition = ToolDefinition;
export type CompiledInvocationToolContract = Readonly<{
  providerDefinition: ProviderToolDefinition;
  providerDefinitionBytes: string;
  resultPolicyTemplate: ToolResultPolicyTemplate;
  resultPolicyTemplateBytes: string;
  resultPolicyTemplateSha256: string;
}>;
export type StaticInvocationPrefix = Readonly<{
  instructionText: string;
  terminalToolNames: readonly string[];
  immutablePrefixBytes: string;
  immutablePrefixSha256: string;
}>;
export type PreparedInvocationContext = Readonly<{
  prefix: StaticInvocationPrefix;
  compiledTools: readonly CompiledInvocationToolContract[];
  internalToolContractSha256: string;
  dynamicBlocks: readonly ContextBlock[];
  dynamicBlocksSha256: string;
  preparedCompaction: PreparedCompaction;
}>;
