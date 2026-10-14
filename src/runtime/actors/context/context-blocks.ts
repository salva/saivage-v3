import type {
  ContextBlock,
  ProviderToolDefinition,
  CompiledInvocationToolContract,
  StaticInvocationPrefix,
  PreparedInvocationContext,
  PreparedCompaction,
} from '../../../contracts/index.js';
import { canonicalJson } from '../../../schemas/index.js';
import { sha256Hex } from '../../../schemas/index.js';
import type { ToolResultPolicyTemplate } from '../../../schemas/index.js';
export type { ContextEvidence, ToolResultPolicyTemplate } from '../../../schemas/index.js';

export function compileInvocationToolContract(
  providerDefinition: ProviderToolDefinition,
  resultPolicyTemplate: ToolResultPolicyTemplate,
): CompiledInvocationToolContract {
  const resultPolicyTemplateBytes = canonicalJson(resultPolicyTemplate);
  return Object.freeze({
    providerDefinition,
    resultPolicyTemplate,
    resultPolicyTemplateBytes,
    resultPolicyTemplateSha256: sha256Hex(resultPolicyTemplateBytes),
  });
}

export function buildStaticInvocationPrefix(
  instructionText: string,
  terminalToolNames: readonly string[],
): StaticInvocationPrefix {
  return Object.freeze({
    instructionText,
    terminalToolNames: Object.freeze([...terminalToolNames]),
  });
}

export function selectLatestContextBlocks(
  blocks: readonly ContextBlock[],
): readonly ContextBlock[] {
  const latest = new Map<string, number>();
  for (const [index, block] of blocks.entries())
    if (block.replacement.kind === 'latest_snapshot') latest.set(block.replacement.key, index);
  return Object.freeze(
    blocks.filter(
      (block, index) =>
        block.replacement.kind !== 'latest_snapshot' || latest.get(block.replacement.key) === index,
    ),
  );
}

export function buildPreparedInvocationContext(
  input: Readonly<{
    instructionText: string;
    terminalToolNames: readonly string[];
    compiledTools: readonly CompiledInvocationToolContract[];
    stableBlocks: readonly ContextBlock[];
    recordBlocks?: readonly ContextBlock[];
    preparedCompaction: PreparedCompaction;
  }>,
): PreparedInvocationContext {
  return Object.freeze({
    prefix: buildStaticInvocationPrefix(input.instructionText, input.terminalToolNames),
    compiledTools: Object.freeze([...input.compiledTools]),
    stableBlocks: Object.freeze([...input.stableBlocks]),
    recordBlocks: Object.freeze([...(input.recordBlocks ?? [])]),
    preparedCompaction: input.preparedCompaction,
  });
}

/** Ordered request context; no stored duplicate combined array. */
export function composedPreparedBlocks(
  context: PreparedInvocationContext,
): readonly ContextBlock[] {
  return [...context.stableBlocks, ...context.recordBlocks];
}

export function withPreparedRecordBlocks(
  context: PreparedInvocationContext,
  recordBlocks: readonly ContextBlock[],
): PreparedInvocationContext {
  return Object.freeze({
    ...context,
    recordBlocks: Object.freeze([...recordBlocks]),
  });
}
