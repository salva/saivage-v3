import { describe, expect, it } from '@jest/globals';
import { conversationSha256 } from '../../../../src/persistence/canonical-conversation-artifacts.js';
import { canonicalJson } from '../../../../src/schemas/index.js';
import {
  assertPreparedContextContinuity,
  buildPreparedInvocationContext,
  buildStaticInvocationPrefix,
  compileInvocationToolContract,
  contextContentSha256,
  dynamicBlocksSha256,
  internalToolContractSha256,
  selectLatestContextBlocks,
  type CompiledInvocationToolContract,
  type ContextBlock,
  type ProviderToolDefinition,
  type ToolResultPolicyTemplate,
} from '../../../../src/runtime/actors/context/context-blocks.js';
import type { PreparedCompaction } from '../../../../src/runtime/actors/llm-invocation.js';

const block = (id: string, overrides: Partial<Omit<ContextBlock, 'id'>> = {}): ContextBlock => ({
  id,
  role: 'user',
  content: `content:${id}`,
  storage: 'durable',
  replacement: { kind: 'retain' },
  audience: 'primary_and_summarizer',
  evidence: { kind: 'none' },
  canonicalSource: null,
  ...overrides,
});
const snapshotBlock = (id: string, key: string, content: string): ContextBlock =>
  block(id, { content, storage: 'activation_local', replacement: { kind: 'latest_snapshot', key, contentSha256: contextContentSha256(content) } });
const providerDefinition: ProviderToolDefinition = { type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false } } };
const retainTemplate: ToolResultPolicyTemplate = { storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'primary_and_summarizer', evidenceMode: 'none' };
const observationalTemplate: ToolResultPolicyTemplate = { storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'summarizer_only', evidenceMode: 'observational_query' };

describe('context contracts', () => {
  it('selects the last same-key latest_snapshot block in composition order and keeps everything else', () => {
    const blocks = [
      snapshotBlock('a1', 'analyst.project_tree', 'tree-v1'),
      block('r1'),
      snapshotBlock('k2', 'other.key', 'other-v1'),
      snapshotBlock('a2', 'analyst.project_tree', 'tree-v2'),
      block('r2'),
      snapshotBlock('k1', 'other.key', 'other-v2'),
    ];
    const selected = selectLatestContextBlocks(blocks);
    expect(selected.map((item) => item.id)).toEqual(['r1', 'a2', 'r2', 'k1']);
    expect(selected.find((item) => item.id === 'a2')?.content).toBe('tree-v2');
    expect(Object.isFrozen(selected)).toBe(true);
  });
  it('keeps retain blocks and independent snapshot keys untouched', () => {
    const blocks = [snapshotBlock('a', 'k1', 'v1'), snapshotBlock('b', 'k2', 'v1'), snapshotBlock('c', 'k1', 'v2')];
    expect(selectLatestContextBlocks(blocks).map((item) => item.id)).toEqual(['b', 'c']);
    expect(selectLatestContextBlocks([block('solo')]).map((item) => item.id)).toEqual(['solo']);
    expect(selectLatestContextBlocks([])).toEqual([]);
  });
  it('compiles tool contracts with canonical bytes and matching hashes', () => {
    const contract = compileInvocationToolContract(providerDefinition, observationalTemplate);
    expect(contract.providerDefinitionBytes).toBe(canonicalJson(providerDefinition));
    expect(contract.resultPolicyTemplateBytes).toBe(canonicalJson(observationalTemplate));
    expect(contract.resultPolicyTemplateSha256).toBe(conversationSha256(canonicalJson(observationalTemplate)));
    expect(Object.isFrozen(contract)).toBe(true);
    const reordered = compileInvocationToolContract(
      { type: 'function', function: { parameters: providerDefinition.function.parameters, description: 'Lookup', name: 'lookup' } },
      observationalTemplate,
    );
    expect(reordered.providerDefinitionBytes).toBe(contract.providerDefinitionBytes);
  });
  it('commits the internal tool contract to the ordered provider/template byte pairs', () => {
    const first = compileInvocationToolContract(providerDefinition, retainTemplate);
    const second = compileInvocationToolContract(providerDefinition, observationalTemplate);
    const ordered: readonly CompiledInvocationToolContract[] = [first, second];
    expect(internalToolContractSha256(ordered)).toBe(conversationSha256(canonicalJson([
      { providerDefinitionBytes: first.providerDefinitionBytes, resultPolicyTemplateBytes: first.resultPolicyTemplateBytes },
      { providerDefinitionBytes: second.providerDefinitionBytes, resultPolicyTemplateBytes: second.resultPolicyTemplateBytes },
    ])));
    expect(internalToolContractSha256([second, first])).not.toBe(internalToolContractSha256(ordered));
    expect(internalToolContractSha256([first, first])).not.toBe(internalToolContractSha256(ordered));
  });
  it('builds the static invocation prefix from exactly instructions, provider bytes, and terminal names', () => {
    const tools = [compileInvocationToolContract(providerDefinition, observationalTemplate)];
    const prefix = buildStaticInvocationPrefix('instruction', ['emit_result'], tools);
    const expectedBytes = canonicalJson({ instructionText: 'instruction', providerToolDefinitionBytes: tools.map((tool) => tool.providerDefinitionBytes), terminalToolNames: ['emit_result'] });
    expect(prefix.immutablePrefixBytes).toBe(expectedBytes);
    expect(prefix.immutablePrefixSha256).toBe(conversationSha256(expectedBytes));
    expect(prefix.instructionText).toBe('instruction');
    expect(prefix.terminalToolNames).toEqual(['emit_result']);
    expect(Object.isFrozen(prefix)).toBe(true);
    expect(Object.isFrozen(prefix.terminalToolNames)).toBe(true);
    expect(buildStaticInvocationPrefix('instruction', ['emit_result'], tools).immutablePrefixSha256).toBe(prefix.immutablePrefixSha256);
    expect(buildStaticInvocationPrefix('changed', ['emit_result'], tools).immutablePrefixSha256).not.toBe(prefix.immutablePrefixSha256);
    expect(buildStaticInvocationPrefix('instruction', ['other'], tools).immutablePrefixBytes).not.toBe(prefix.immutablePrefixBytes);
    expect(buildStaticInvocationPrefix('instruction', ['emit_result'], [...tools, tools[0]!]).immutablePrefixBytes).not.toBe(prefix.immutablePrefixBytes);
  });
  it('hashes dynamic blocks canonically and order-sensitively', () => {
    const first = snapshotBlock('a', 'k', 'v1');
    const second = block('b', { audience: 'summarizer_only', evidence: { kind: 'observational_query', tool: 'get_card', arguments: { cardId: 'card-1' }, observed_sha256: '0'.repeat(64) }, canonicalSource: { session_id: 'agent:analyst:global', source_input_id: '00000000-0000-4000-8000-000000000001', tool_call_id: 'call-1' } });
    expect(dynamicBlocksSha256([first, second])).toBe(conversationSha256(canonicalJson([first, second])));
    expect(dynamicBlocksSha256([second, first])).not.toBe(dynamicBlocksSha256([first, second]));
    expect(contextContentSha256(first.content)).toBe(conversationSha256(first.content));
  });
  it('builds one frozen prepared invocation context from its exact inputs', () => {
    const preparedCompaction = { inputBudgetTokens: 1 } as PreparedCompaction;
    const compiledTools = [compileInvocationToolContract(providerDefinition, observationalTemplate)];
    const prepared = buildPreparedInvocationContext({ instructionText: 'instruction', terminalToolNames: ['emit_result'], compiledTools, dynamicBlocks: [snapshotBlock('a', 'k', 'v1')], preparedCompaction });
    expect(prepared.prefix).toEqual(buildStaticInvocationPrefix('instruction', ['emit_result'], compiledTools));
    expect(prepared.compiledTools).toEqual(compiledTools);
    expect(prepared.internalToolContractSha256).toBe(internalToolContractSha256(compiledTools));
    expect(prepared.dynamicBlocksSha256).toBe(dynamicBlocksSha256([snapshotBlock('a', 'k', 'v1')]));
    expect(prepared.preparedCompaction).toBe(preparedCompaction);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.compiledTools)).toBe(true);
    expect(Object.isFrozen(prepared.dynamicBlocks)).toBe(true);
  });
  it('accepts byte-identical prepared contexts and rejects every frozen-contract drift across continuations', () => {
    const preparedCompaction = { inputBudgetTokens: 1 } as PreparedCompaction;
    const compiledTools = [compileInvocationToolContract(providerDefinition, observationalTemplate)];
    const base = buildPreparedInvocationContext({ instructionText: 'instruction', terminalToolNames: ['emit_result'], compiledTools, dynamicBlocks: [snapshotBlock('a', 'k', 'v1')], preparedCompaction });
    expect(() => assertPreparedContextContinuity(base, buildPreparedInvocationContext({ instructionText: 'instruction', terminalToolNames: ['emit_result'], compiledTools, dynamicBlocks: [snapshotBlock('a', 'k', 'v1')], preparedCompaction }), 'actor-x')).not.toThrow();
    expect(() => assertPreparedContextContinuity(
      base,
      buildPreparedInvocationContext({ instructionText: 'changed', terminalToolNames: ['emit_result'], compiledTools, dynamicBlocks: [snapshotBlock('a', 'k', 'v1')], preparedCompaction }),
      "agent:planner:project 'call-1'",
    )).toThrow(/Prepared invocation prefix changed across agent:planner:project 'call-1' continuation/u);
    expect(() => assertPreparedContextContinuity(
      base,
      buildPreparedInvocationContext({ instructionText: 'instruction', terminalToolNames: ['emit_result'], compiledTools: [compileInvocationToolContract(providerDefinition, retainTemplate)], dynamicBlocks: [snapshotBlock('a', 'k', 'v1')], preparedCompaction }),
      'actor-x',
    )).toThrow(/Prepared internal tool contract changed across actor-x continuation/u);
    expect(() => assertPreparedContextContinuity(
      base,
      buildPreparedInvocationContext({ instructionText: 'instruction', terminalToolNames: ['emit_result'], compiledTools, dynamicBlocks: [snapshotBlock('a', 'k', 'v2')], preparedCompaction }),
      'actor-x',
    )).toThrow(/Prepared dynamic context blocks changed across actor-x continuation/u);
  });
});
