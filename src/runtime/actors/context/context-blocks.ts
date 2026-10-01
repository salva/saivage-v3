import type { ContextBlock, ProviderToolDefinition, CompiledInvocationToolContract, StaticInvocationPrefix, PreparedInvocationContext, PreparedCompaction } from '../../../contracts/index.js';
import { canonicalJson } from '../../../schemas/index.js';
import { sha256Hex, canonicalValueSha256 } from '../../../schemas/index.js';
import type { ToolResultPolicyTemplate } from '../../../schemas/index.js';
export type { ContextEvidence, ToolResultPolicyTemplate } from '../../../schemas/index.js';

export function compileInvocationToolContract(providerDefinition: ProviderToolDefinition, resultPolicyTemplate: ToolResultPolicyTemplate): CompiledInvocationToolContract {
  const providerDefinitionBytes = canonicalJson(providerDefinition);
  const resultPolicyTemplateBytes = canonicalJson(resultPolicyTemplate);
  return Object.freeze({
    providerDefinition,
    providerDefinitionBytes,
    resultPolicyTemplate,
    resultPolicyTemplateBytes,
    resultPolicyTemplateSha256: sha256Hex(resultPolicyTemplateBytes),
  });
}

export const internalToolContractSha256 = (compiledTools: readonly CompiledInvocationToolContract[]): string =>
  canonicalValueSha256(compiledTools.map((tool) => ({ providerDefinitionBytes: tool.providerDefinitionBytes, resultPolicyTemplateBytes: tool.resultPolicyTemplateBytes })));

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
    immutablePrefixSha256: sha256Hex(immutablePrefixBytes),
  });
}

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
    dynamicBlocksSha256: canonicalValueSha256(input.dynamicBlocks),
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
