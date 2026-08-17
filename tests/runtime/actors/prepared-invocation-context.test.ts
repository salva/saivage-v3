import { describe, expect, it } from '@jest/globals';

import { buildCandidateRequest } from '../../../src/agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../../../src/agents/llm-protocol-adapter.js';
import type { LlmCompleteOptions, ProviderToolDefinition } from '../../../src/agents/llm-contracts.js';
import {
  assertPreparedInvocationContextEqual,
  compileInvocationToolContract,
  prepareInvocationContext,
  type ToolResultPolicyTemplate,
} from '../../../src/runtime/actors/llm-invocation.js';
import type { ContextBlock } from '../../../src/runtime/actors/context/index.js';

const providerDefinition: ProviderToolDefinition = {
  type: 'function',
  function: { name: 'lookup', description: 'Look up a value.', parameters: { type: 'object', properties: {} } },
};
const nonePolicy: ToolResultPolicyTemplate = { storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'primary_and_summarizer', evidenceMode: 'none' };
const observationalPolicy: ToolResultPolicyTemplate = { storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'summarizer_only', evidenceMode: 'observational_query' };
const dynamicBlock: ContextBlock = { id: 'card', role: 'system', content: 'card context', storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, canonicalSource: null };

describe('prepared invocation context', () => {
  it('separates provider-definition bytes from internal policy bytes and hashes', () => {
    const none = compileInvocationToolContract(providerDefinition, nonePolicy);
    const observational = compileInvocationToolContract(providerDefinition, observationalPolicy);
    const first = prepareInvocationContext({ instructionText: 'instructions', compiledTools: [none], terminalToolNames: [], dynamicBlocks: [dynamicBlock] });
    const second = prepareInvocationContext({ instructionText: 'instructions', compiledTools: [observational], terminalToolNames: [], dynamicBlocks: [dynamicBlock] });
    expect(none.providerDefinitionBytes).toBe(observational.providerDefinitionBytes);
    expect(none.resultPolicyTemplateSha256).not.toBe(observational.resultPolicyTemplateSha256);
    expect(first.prefix.immutablePrefixBytes).toBe(second.prefix.immutablePrefixBytes);
    expect(first.internalToolContractSha256).not.toBe(second.internalToolContractSha256);
    expect(first.prefix.immutablePrefixBytes).not.toContain('evidenceMode');
  });

  it('asserts byte-identical prefix, internal tool contract, and dynamic blocks across continuations', () => {
    const tool = compileInvocationToolContract(providerDefinition, nonePolicy);
    const prepared = prepareInvocationContext({ instructionText: 'instructions', compiledTools: [tool], terminalToolNames: [], dynamicBlocks: [dynamicBlock] });
    expect(() => assertPreparedInvocationContextEqual(prepared, prepared)).not.toThrow();
    const changed = prepareInvocationContext({ instructionText: 'instructions', compiledTools: [tool], terminalToolNames: [], dynamicBlocks: [{ ...dynamicBlock, content: 'changed card' }] });
    expect(() => assertPreparedInvocationContextEqual(prepared, changed)).toThrow(/dynamic context blocks/);
  });

  it('rejects a terminal name without its exact compiled provider contract', () => {
    expect(() => prepareInvocationContext({ instructionText: 'instructions', compiledTools: [], terminalToolNames: ['emit_result'], dynamicBlocks: [] }))
      .toThrow(/absent from the compiled invocation tools/);
  });

  it('sends instructions then dynamic context and only the provider definition', () => {
    const tool = compileInvocationToolContract(providerDefinition, observationalPolicy);
    const prepared = prepareInvocationContext({ instructionText: 'static-instruction-marker', compiledTools: [tool], terminalToolNames: [], dynamicBlocks: [{ ...dynamicBlock, content: 'dynamic-context-marker' }] });
    const options: LlmCompleteOptions = { inputId: 'input', temperature: 0, max_tokens: 100, contract_id: 'test', contractName: 'test', terminalToolOffered: [], tools: [tool.providerDefinition], tool_choice: 'auto' };
    const plan = buildCandidateRequest({
      candidate: { provider: 'test', account: null, model: 'model' },
      capabilities: { transportProtocol: 'openai-chat-completions', toolsMode: 'native', exclusiveToolChoiceSupport: 'native', contextWindowTokens: 1000, maxOutputTokens: 100, quirks: [] },
      adapter: selectLlmProtocolAdapter('openai-chat-completions'),
      instructionText: prepared.prefix.instructionText,
      dynamicBlocks: prepared.dynamicBlocks,
      providerConversation: { sourceSessionId: null, messages: [] },
      options,
    });
    const serialized = plan.request.serializedBody;
    expect(serialized.indexOf('static-instruction-marker')).toBeLessThan(serialized.indexOf('dynamic-context-marker'));
    expect(serialized).toContain('lookup');
    expect(serialized).not.toContain('observational_query');
    expect(serialized).not.toContain('settledAudience');
  });
});
