import { describe, expect, it } from '@jest/globals';
import { sha256Hex } from '../../../../src/schemas/index.js';
import { canonicalJson } from '../../../../src/schemas/index.js';
import { buildPreparedInvocationContext, buildStaticInvocationPrefix, compileInvocationToolContract, composedPreparedBlocks, withPreparedRecordBlocks, selectLatestContextBlocks, type ToolResultPolicyTemplate } from '../../../../src/runtime/actors/context/context-blocks.js';
import { type ContextBlock, type ProviderToolDefinition } from '../../../../src/contracts/index.js';
import type { PreparedCompaction } from '../../../../src/contracts/index.js';

const block = (id: string, overrides: Partial<Omit<ContextBlock, 'id'>> = {}): ContextBlock => ({
  id,
  role: 'user',
  content: `content:${id}`,
  storage: 'durable',
  replacement: { kind: 'retain' },
  audience: 'primary_and_summarizer',
  evidence: { kind: 'none' },
  ...overrides,
});
const snapshotBlock = (id: string, key: string, content: string): ContextBlock =>
  block(id, { content, storage: 'activation_local', replacement: { kind: 'latest_snapshot', key, contentSha256: sha256Hex(content) } });
const providerDefinition: ProviderToolDefinition = { type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false } } };
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
    expect(contract.providerDefinition).toBe(providerDefinition);
    expect(contract.resultPolicyTemplateBytes).toBe(canonicalJson(observationalTemplate));
    expect(contract.resultPolicyTemplateSha256).toBe(sha256Hex(canonicalJson(observationalTemplate)));
    expect(Object.isFrozen(contract)).toBe(true);
  });
  it('retains instructions and frozen terminal names', () => {
    const prefix = buildStaticInvocationPrefix('instruction', ['emit_result']);
    expect(prefix.instructionText).toBe('instruction');
    expect(prefix.terminalToolNames).toEqual(['emit_result']);
    expect(Object.isFrozen(prefix)).toBe(true);
    expect(Object.isFrozen(prefix.terminalToolNames)).toBe(true);
  });
  it('builds one frozen prepared invocation context from its exact inputs', () => {
    const preparedCompaction = { routeUsableInputTokens: 1 } as unknown as PreparedCompaction;
    const compiledTools = [compileInvocationToolContract(providerDefinition, observationalTemplate)];
    const prepared = buildPreparedInvocationContext({ instructionText: 'instruction', terminalToolNames: ['emit_result'], compiledTools, stableBlocks: [snapshotBlock('a', 'k', 'v1')], preparedCompaction });
    expect(prepared.prefix).toEqual(buildStaticInvocationPrefix('instruction', ['emit_result']));
    expect(prepared.compiledTools).toEqual(compiledTools);
    expect(prepared.stableBlocks).toEqual([snapshotBlock('a', 'k', 'v1')]);
    expect(prepared.preparedCompaction).toBe(preparedCompaction);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.compiledTools)).toBe(true);
    expect(Object.isFrozen(prepared.stableBlocks)).toBe(true);
  });
  it('replaces frozen record blocks while sharing stable values and preserving composition order', () => {
    const preparedCompaction = { routeUsableInputTokens: 1 } as unknown as PreparedCompaction;
    const compiledTools = [compileInvocationToolContract(providerDefinition, observationalTemplate)];
    const base = buildPreparedInvocationContext({ instructionText: 'instruction', terminalToolNames: ['emit_result'], compiledTools, stableBlocks: [snapshotBlock('a', 'k', 'v1')], preparedCompaction });
    const operationA = withPreparedRecordBlocks(base, [snapshotBlock('record', 'record', 'A')]);
    const operationB = withPreparedRecordBlocks(operationA, [snapshotBlock('record', 'record', 'B')]);
    expect(operationB).not.toBe(operationA);
    expect(operationB.prefix).toBe(operationA.prefix);
    expect(operationB.compiledTools).toBe(operationA.compiledTools);
    expect(operationB.preparedCompaction).toBe(preparedCompaction);
    expect(operationB.recordBlocks).toEqual([snapshotBlock('record', 'record', 'B')]);
    expect(operationA.recordBlocks).toEqual([snapshotBlock('record', 'record', 'A')]);
    expect(Object.isFrozen(operationB)).toBe(true);
    expect(Object.isFrozen(operationB.recordBlocks)).toBe(true);
    expect(operationB.stableBlocks).toBe(operationA.stableBlocks);
    expect(composedPreparedBlocks(operationB)).toEqual([...base.stableBlocks, ...operationB.recordBlocks]);
    expect(base.recordBlocks).toEqual([]);
  });
});
