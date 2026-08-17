import type { AgentName, CanonicalToolResultPolicyTemplate, ConversationSessionId } from '../../schemas/index.js';
import { createHash } from 'node:crypto';

import type { ProviderConversationProjection, ProviderToolDefinition } from '../../agents/llm-contracts.js';
import type { CapabilityRequest } from '../../agents/provider-capabilities.js';
import type { Candidate } from '../../contracts/provider-candidate.js';
import { canonicalJson } from '../../schemas/index.js';
import { dynamicBlocksSha256, selectLatestContextSnapshots, type ContextBlock } from './context/index.js';

export type ToolResultPolicyTemplate = Readonly<CanonicalToolResultPolicyTemplate>;

export type ToolEvidenceMode = ToolResultPolicyTemplate['evidenceMode'];

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

export const PRIMARY_TOOL_RESULT_POLICY_TEMPLATE = Object.freeze({
  storage: 'durable',
  replacement: Object.freeze({ kind: 'retain' }),
  settledAudience: 'primary_and_summarizer',
  evidenceMode: 'none',
} as const) satisfies ToolResultPolicyTemplate;

export const OBSERVATIONAL_TOOL_RESULT_POLICY_TEMPLATE = Object.freeze({
  storage: 'durable',
  replacement: Object.freeze({ kind: 'retain' }),
  settledAudience: 'summarizer_only',
  evidenceMode: 'observational_query',
} as const) satisfies ToolResultPolicyTemplate;

export const CANONICAL_TOOL_RESULT_POLICY_TEMPLATE = Object.freeze({
  storage: 'durable',
  replacement: Object.freeze({ kind: 'retain' }),
  settledAudience: 'summarizer_only',
  evidenceMode: 'canonical_locator',
} as const) satisfies ToolResultPolicyTemplate;

export const EVIDENCE_ONLY_TOOL_RESULT_POLICY_TEMPLATE = Object.freeze({
  storage: 'durable',
  replacement: Object.freeze({ kind: 'retain' }),
  settledAudience: 'evidence_only',
  evidenceMode: 'none',
} as const) satisfies ToolResultPolicyTemplate;

export const MCP_TOOL_RESULT_POLICY_TEMPLATE = PRIMARY_TOOL_RESULT_POLICY_TEMPLATE;
export const UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE = PRIMARY_TOOL_RESULT_POLICY_TEMPLATE;

export function compileInvocationToolContract(
  providerDefinition: ProviderToolDefinition,
  resultPolicyTemplate: ToolResultPolicyTemplate,
): CompiledInvocationToolContract {
  const frozenProviderDefinition = deepFreeze(structuredClone(providerDefinition));
  const frozenResultPolicyTemplate = deepFreeze(structuredClone(resultPolicyTemplate));
  const providerDefinitionBytes = canonicalJson(frozenProviderDefinition);
  const resultPolicyTemplateBytes = canonicalJson(frozenResultPolicyTemplate);
  return Object.freeze({
    providerDefinition: frozenProviderDefinition,
    providerDefinitionBytes,
    resultPolicyTemplate: frozenResultPolicyTemplate,
    resultPolicyTemplateBytes,
    resultPolicyTemplateSha256: sha256(resultPolicyTemplateBytes),
  });
}

export function compileStaticInvocationPrefix(args: Readonly<{
  instructionText: string;
  compiledTools: readonly CompiledInvocationToolContract[];
  terminalToolNames: readonly string[];
}>): StaticInvocationPrefix {
  if (!args.instructionText.trim()) throw new Error('Static invocation instruction text must not be empty.');
  const terminalToolNames = Object.freeze([...args.terminalToolNames]);
  if (new Set(terminalToolNames).size !== terminalToolNames.length)
    throw new Error('Static invocation terminal tool names must be unique.');
  const compiledToolNames = args.compiledTools.map((tool) => tool.providerDefinition.function.name);
  if (new Set(compiledToolNames).size !== compiledToolNames.length)
    throw new Error('Compiled invocation tool names must be unique.');
  for (const name of terminalToolNames) if (!compiledToolNames.includes(name))
    throw new Error(`Static invocation terminal tool '${name}' is absent from the compiled invocation tools.`);
  const immutablePrefixBytes = canonicalJson({
    instructionText: args.instructionText,
    providerToolDefinitionBytes: args.compiledTools.map((tool) => tool.providerDefinitionBytes),
    terminalToolNames,
  });
  return Object.freeze({
    instructionText: args.instructionText,
    terminalToolNames,
    immutablePrefixBytes,
    immutablePrefixSha256: sha256(immutablePrefixBytes),
  });
}

export function internalToolContractSha256(tools: readonly CompiledInvocationToolContract[]): string {
  return sha256(canonicalJson(tools.map((tool) => ({
    providerDefinitionBytes: tool.providerDefinitionBytes,
    resultPolicyTemplateBytes: tool.resultPolicyTemplateBytes,
  }))));
}

export function assertPreparedInvocationContextEqual(
  expected: Pick<LlmInvocationInputBase, 'prefix' | 'compiledTools' | 'internalToolContractSha256' | 'dynamicBlocks' | 'dynamicBlocksSha256'>,
  actual: Pick<LlmInvocationInputBase, 'prefix' | 'compiledTools' | 'internalToolContractSha256' | 'dynamicBlocks' | 'dynamicBlocksSha256'>,
): void {
  if (expected.prefix.immutablePrefixSha256 !== actual.prefix.immutablePrefixSha256
    || expected.prefix.immutablePrefixBytes !== actual.prefix.immutablePrefixBytes)
    throw new Error('LLM continuation changed its immutable static invocation prefix.');
  if (expected.internalToolContractSha256 !== actual.internalToolContractSha256)
    throw new Error('LLM continuation changed its internal tool contract.');
  if (expected.dynamicBlocksSha256 !== actual.dynamicBlocksSha256
    || canonicalJson(expected.dynamicBlocks) !== canonicalJson(actual.dynamicBlocks))
    throw new Error('LLM continuation changed its prepared dynamic context blocks.');
  if (canonicalJson(expected.compiledTools.map(contractIdentity)) !== canonicalJson(actual.compiledTools.map(contractIdentity)))
    throw new Error('LLM continuation changed its compiled invocation tools.');
}

export function prepareInvocationContext(args: Readonly<{
  instructionText: string;
  compiledTools: readonly CompiledInvocationToolContract[];
  terminalToolNames: readonly string[];
  dynamicBlocks: readonly ContextBlock[];
}>): Readonly<{
  prefix: StaticInvocationPrefix;
  compiledTools: readonly CompiledInvocationToolContract[];
  internalToolContractSha256: string;
  dynamicBlocks: readonly ContextBlock[];
  dynamicBlocksSha256: string;
}> {
  const compiledTools = Object.freeze([...args.compiledTools]);
  compiledTools.forEach(assertCompiledToolContract);
  const dynamicBlocks = selectLatestContextSnapshots(args.dynamicBlocks);
  return Object.freeze({
    prefix: compileStaticInvocationPrefix({
      instructionText: args.instructionText,
      compiledTools,
      terminalToolNames: args.terminalToolNames,
    }),
    compiledTools,
    internalToolContractSha256: internalToolContractSha256(compiledTools),
    dynamicBlocks,
    dynamicBlocksSha256: dynamicBlocksSha256(dynamicBlocks),
  });
}

function contractIdentity(contract: CompiledInvocationToolContract): readonly string[] {
  return [contract.providerDefinitionBytes, contract.resultPolicyTemplateBytes];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertCompiledToolContract(contract: CompiledInvocationToolContract): void {
  if (canonicalJson(contract.providerDefinition) !== contract.providerDefinitionBytes)
    throw new Error(`Compiled provider definition bytes do not match tool '${contract.providerDefinition.function.name}'.`);
  if (canonicalJson(contract.resultPolicyTemplate) !== contract.resultPolicyTemplateBytes)
    throw new Error(`Compiled result policy bytes do not match tool '${contract.providerDefinition.function.name}'.`);
  if (sha256(contract.resultPolicyTemplateBytes) !== contract.resultPolicyTemplateSha256)
    throw new Error(`Compiled result policy hash does not match tool '${contract.providerDefinition.function.name}'.`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
  return Object.freeze(value);
}

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
  prefix: StaticInvocationPrefix;
  /** Current provider-eligible rows from one source-identified validated canonical conversation. */
  providerConversation: ProviderConversationProjection;
  compiledTools: readonly CompiledInvocationToolContract[];
  internalToolContractSha256: string;
  dynamicBlocks: readonly ContextBlock[];
  dynamicBlocksSha256: string;
  capabilityRequest: CapabilityRequest;
  episodeContext: Record<string, unknown>;
  routePass: InvocationRoutePass;
}

export type LlmInvocationInput = LlmInvocationInputBase & (
  | { preparedCompaction: PreparedCompaction; modelParams: { temperature: number; maxTokens?: never } }
  | { preparedCompaction?: never; modelParams: { temperature: number; maxTokens: number } }
);

export type CanonicalLlmInvocationInput = LlmInvocationInput & { sessionId: ConversationSessionId };
export type PreparedLlmInvocationInput = Extract<CanonicalLlmInvocationInput, { preparedCompaction: PreparedCompaction }>;
