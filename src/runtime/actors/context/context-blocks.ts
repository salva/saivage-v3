import type { ToolDefinition } from '../../../agents/llm-contracts.js';
import { canonicalJson } from '../../../schemas/index.js';
import { conversationSha256 } from '../../../persistence/canonical-conversation-artifacts.js';
import type { ContextAudience, ContextEvidence, ContextReplacement, ToolResultPolicyTemplate } from '../../../schemas/index.js';
import type { PreparedCompaction } from '../llm-invocation.js';

type ContextStorage = 'durable' | 'activation_local';
export type { ContextEvidence, ToolResultPolicyTemplate } from '../../../schemas/index.js';

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
type StaticInvocationPrefix = Readonly<{
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

export const contextContentSha256 = (content: string): string => conversationSha256(content);

export function compileInvocationToolContract(providerDefinition: ProviderToolDefinition, resultPolicyTemplate: ToolResultPolicyTemplate): CompiledInvocationToolContract {
  const providerDefinitionBytes = canonicalJson(providerDefinition);
  const resultPolicyTemplateBytes = canonicalJson(resultPolicyTemplate);
  return Object.freeze({
    providerDefinition,
    providerDefinitionBytes,
    resultPolicyTemplate,
    resultPolicyTemplateBytes,
    resultPolicyTemplateSha256: conversationSha256(resultPolicyTemplateBytes),
  });
}

export const internalToolContractSha256 = (compiledTools: readonly CompiledInvocationToolContract[]): string =>
  conversationSha256(canonicalJson(compiledTools.map((tool) => ({ providerDefinitionBytes: tool.providerDefinitionBytes, resultPolicyTemplateBytes: tool.resultPolicyTemplateBytes }))));

export function buildStaticInvocationPrefix(instructionText: string, terminalToolNames: readonly string[], compiledTools: readonly CompiledInvocationToolContract[]): StaticInvocationPrefix {
  const immutablePrefixBytes = canonicalJson({
    instructionText,
    providerToolDefinitionBytes: compiledTools.map((tool) => tool.providerDefinitionBytes),
    terminalToolNames: [...terminalToolNames],
  });
  return Object.freeze({
    instructionText,
    terminalToolNames: Object.freeze([...terminalToolNames]),
    immutablePrefixBytes,
    immutablePrefixSha256: conversationSha256(immutablePrefixBytes),
  });
}

export const dynamicBlocksSha256 = (blocks: readonly ContextBlock[]): string => conversationSha256(canonicalJson(blocks));

export function selectLatestContextBlocks(blocks: readonly ContextBlock[]): readonly ContextBlock[] {
  const latest = new Map<string, number>();
  for (const [index, block] of blocks.entries()) if (block.replacement.kind === 'latest_snapshot') latest.set(block.replacement.key, index);
  return Object.freeze(blocks.filter((block, index) => block.replacement.kind !== 'latest_snapshot' || latest.get(block.replacement.key) === index));
}

export function buildPreparedInvocationContext(input: Readonly<{
  instructionText: string;
  terminalToolNames: readonly string[];
  compiledTools: readonly CompiledInvocationToolContract[];
  dynamicBlocks: readonly ContextBlock[];
  preparedCompaction: PreparedCompaction;
}>): PreparedInvocationContext {
  return Object.freeze({
    prefix: buildStaticInvocationPrefix(input.instructionText, input.terminalToolNames, input.compiledTools),
    compiledTools: Object.freeze([...input.compiledTools]),
    internalToolContractSha256: internalToolContractSha256(input.compiledTools),
    dynamicBlocks: Object.freeze([...input.dynamicBlocks]),
    dynamicBlocksSha256: dynamicBlocksSha256(input.dynamicBlocks),
    preparedCompaction: input.preparedCompaction,
  });
}

export function assertPreparedContextContinuity(before: PreparedInvocationContext, after: PreparedInvocationContext, identity: string): void {
  if (before.prefix.immutablePrefixSha256 !== after.prefix.immutablePrefixSha256 || before.prefix.immutablePrefixBytes !== after.prefix.immutablePrefixBytes)
    throw new Error(`Prepared invocation prefix changed across ${identity} continuation.`);
  if (before.internalToolContractSha256 !== after.internalToolContractSha256)
    throw new Error(`Prepared internal tool contract changed across ${identity} continuation.`);
  if (before.dynamicBlocksSha256 !== after.dynamicBlocksSha256)
    throw new Error(`Prepared dynamic context blocks changed across ${identity} continuation.`);
}
