import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { defineTool, invokeTool, invokeToolForLlm, noneToolExecution, providerResultFromSettlement, surfaceCompiledInvocationTools, type ToolExecutionResult, type ToolProvider } from '../../src/tools/invocation.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { PRIMARY_TOOL_RESULT_POLICY_TEMPLATE } from '../../src/runtime/actors/llm-invocation.js';

describe('tool invocation surface', () => {
  const provider = (providerName: string, toolName = 'demo'): ToolProvider => ({
    providerName,
    tools: [
      defineTool({
        name: toolName,
        description: 'Demo tool.',
        inputSchema: z.object({ value: z.string() }).strict(),
        resultPolicyTemplate: PRIMARY_TOOL_RESULT_POLICY_TEMPLATE,
        executor: async (args) => noneToolExecution({ success: true, data: { value: args.value } }),
      }),
    ],
  });

  it('builds complete fixtures with provider and tool identity in supplied order', () => {
    const firstProvider = provider('a', 'first');
    const secondProvider = provider('b', 'second');
    const providers = [firstProvider, secondProvider] as const;
    const surface = buildInvocationSurfaceFixture('executor', providers);

    expect([...surface.tools.keys()]).toEqual(['first', 'second']);
    expect([...surface.tools.values()]).toEqual([firstProvider.tools[0], secondProvider.tools[0]]);
    expect(surface.providers).toBe(providers);
  });

  it('returns model-visible errors for unsupported tool names', async () => {
    const surface = buildInvocationSurfaceFixture('reviewer', [provider('a')]);

    const settlement = await invokeTool(surface, 'missing', {});
    expect(settlement).toMatchObject({ kind: 'synthetic', settlementOrigin: 'unsupported_tool', providerResult: { success: false, error: "Unsupported tool 'missing' for agent 'reviewer'." } });
  });

  it('returns model-visible errors for invalid parsed arguments', async () => {
    const surface = buildInvocationSurfaceFixture('executor', [provider('a')]);

    const result = await invokeTool(surface, 'demo', { value: 1 });

    expect(result).toMatchObject({ kind: 'synthetic', settlementOrigin: 'rejected_before_execution' });
    const providerResult = providerResultFromSettlement(result);
    expect(providerResult.success).toBe(false);
    if (!providerResult.success) expect(providerResult.error).toContain('Expected string');
  });

  it('does not catch executor exceptions', async () => {
    const surface = buildInvocationSurfaceFixture('executor', [{
      providerName: 'buggy',
      tools: [
        defineTool({
          name: 'buggy',
          description: 'Buggy tool.',
          inputSchema: z.object({}).strict(),
          resultPolicyTemplate: PRIMARY_TOOL_RESULT_POLICY_TEMPLATE,
          executor: async () => { throw new Error('programmer bug'); },
        }),
      ],
    }]);

    await expect(invokeTool(surface, 'buggy', {})).rejects.toThrow('programmer bug');
  });

  it('returns model-visible errors from the LLM boundary for non-abort executor exceptions', async () => {
    const surface = buildInvocationSurfaceFixture('analyst', [{
      providerName: 'buggy',
      tools: [
        defineTool({
          name: 'buggy',
          description: 'Buggy tool.',
          inputSchema: z.object({}).strict(),
          resultPolicyTemplate: PRIMARY_TOOL_RESULT_POLICY_TEMPLATE,
          executor: async () => { throw new Error('programmer bug'); },
        }),
      ],
    }]);

    await expect(invokeToolForLlm(surface, 'buggy', {}, testLlmToolInvocationContext({ toolName: 'buggy' }))).resolves.toMatchObject({ kind: 'synthetic', settlementOrigin: 'execution_failed', providerResult: { success: false, error: 'programmer bug' } });
  });

  it('rethrows from the LLM boundary when the signal is already aborted', async () => {
    const surface = buildInvocationSurfaceFixture('analyst', [provider('a')]);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(invokeToolForLlm(surface, 'demo', { value: 'ok' }, testLlmToolInvocationContext({ toolName: 'demo' }), controller.signal)).rejects.toThrow('cancelled');
  });

  it('rethrows app-log publication failures unchanged from the LLM boundary', async () => {
    const publicationError = new PublicationOutcomeUnknownError();
    const surface = buildInvocationSurfaceFixture('analyst', [{
      providerName: 'publication',
      tools: [defineTool({ name: 'publish', description: 'Publish.', inputSchema: z.object({}).strict(), resultPolicyTemplate: PRIMARY_TOOL_RESULT_POLICY_TEMPLATE, executor: async () => { throw publicationError; } })],
    }]);

    await expect(invokeToolForLlm(surface, 'publish', {}, testLlmToolInvocationContext({ toolName: 'publish' }))).rejects.toBe(publicationError);
  });

  it.each(['fulfill', 'same-reject', 'different-reject'] as const)('gives exact Stop identity priority after abort-ignoring tool %s', async (mode) => {
    let resolve!: (value: ToolExecutionResult<'none'>) => void;
    let reject!: (error: unknown) => void;
    const tool = new Promise<ToolExecutionResult<'none'>>((done, fail) => { resolve = done; reject = fail; });
    const surface = buildInvocationSurfaceFixture('planner', [{ providerName: 'controlled', tools: [defineTool({ name: 'controlled', description: 'controlled', inputSchema: z.object({}).strict(), resultPolicyTemplate: PRIMARY_TOOL_RESULT_POLICY_TEMPLATE, executor: () => tool })] }]);
    const controller = new AbortController();
    const interruption = new RuntimeStoppedInterruption();
    const pending = invokeToolForLlm(surface, 'controlled', {}, testLlmToolInvocationContext({ toolName: 'controlled' }), controller.signal);
    await Promise.resolve();
    controller.abort(interruption);
    if (mode === 'fulfill') resolve(noneToolExecution({ success: true }));
    else if (mode === 'same-reject') reject(interruption);
    else reject(new Error('different tool failure'));
    await expect(pending).rejects.toBe(interruption);
  });

  it('projects invocation surface tools to LLM tool definitions', () => {
    const surface = buildInvocationSurfaceFixture('planner', [provider('a')]);

    expect(surfaceCompiledInvocationTools(surface).map((contract) => contract.providerDefinition)).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({
          name: 'demo',
          description: 'Demo tool.',
          parameters: expect.objectContaining({ type: 'object' }),
        }),
      }),
    ]);
    expect(surfaceCompiledInvocationTools(surface)[0]!.providerDefinition).not.toHaveProperty('resultPolicyTemplate');
  });

  it('enforces evidence mode at compile time and runtime', async () => {
    defineTool({ name: 'none', description: 'none', inputSchema: z.object({}).strict(), resultPolicyTemplate: PRIMARY_TOOL_RESULT_POLICY_TEMPLATE, executor: async () => noneToolExecution({ success: true }) });
    const wrong: ToolExecutionResult<'observational_query'> = { providerResult: { success: true }, evidence: { kind: 'observational_result_bytes' } };
    // @ts-expect-error observational evidence cannot implement a none-mode definition
    defineTool({ name: 'wrong', description: 'wrong', inputSchema: z.object({}).strict(), resultPolicyTemplate: PRIMARY_TOOL_RESULT_POLICY_TEMPLATE, executor: async () => wrong });
    const base = provider('forged').tools[0]!;
    const forged = { ...base, executor: async () => wrong as never };
    await expect(invokeTool(buildInvocationSurfaceFixture('executor', [{ providerName: 'forged', tools: [forged] }]), 'demo', { value: 'x' })).rejects.toThrow(/does not match fixed mode/);
  });
});
