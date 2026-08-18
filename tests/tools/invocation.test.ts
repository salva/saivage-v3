import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { defineTool, invokeTool, invokeToolForLlm, OPERATIONAL_RESULT_POLICY_TEMPLATE, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, surfaceToolDefinitions, settlementProviderResult, syntheticToolSettlement, executedProviderResult, type ToolExecutionResult, type ToolProvider } from '../../src/tools/invocation.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';

describe('tool invocation surface', () => {
  const provider = (providerName: string, toolName = 'demo'): ToolProvider => ({
    providerName,
    tools: [
      defineTool({
        name: toolName,
        description: 'Demo tool.',
        resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
        inputSchema: z.object({ value: z.string() }).strict(),
        executor: async (args) => executedProviderResult('none', { success: true, data: { value: args.value } }),
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

  it('fails fast for unsupported tool names at the executed boundary', async () => {
    const surface = buildInvocationSurfaceFixture('reviewer', [provider('a')]);

    await expect(invokeTool(surface, 'missing', {})).rejects.toThrow("Unsupported tool 'missing' for agent 'reviewer'.");
    await expect(invokeToolForLlm(surface, 'missing', {}, testLlmToolInvocationContext({ toolName: 'missing' }))).resolves.toEqual(syntheticToolSettlement('unsupported_tool', "Unsupported tool 'missing' for agent 'reviewer'."));
  });

  it('classifies invalid parsed arguments as rejected-before-execution settlement', async () => {
    const surface = buildInvocationSurfaceFixture('executor', [provider('a')]);

    await expect(invokeTool(surface, 'demo', { value: 1 })).rejects.toThrow(/Expected string/);
    const settlement = await invokeToolForLlm(surface, 'demo', { value: 1 }, testLlmToolInvocationContext({ toolName: 'demo' }));
    expect(settlement.kind).toBe('rejected_before_execution');
    const result = settlementProviderResult(settlement);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Expected string');
  });

  it('does not catch executor exceptions at the executed boundary', async () => {
    const surface = buildInvocationSurfaceFixture('executor', [{
      providerName: 'buggy',
      tools: [
        defineTool({
          name: 'buggy',
          description: 'Buggy tool.',
          resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
          inputSchema: z.object({}).strict(),
          executor: async () => { throw new Error('programmer bug'); },
        }),
      ],
    }]);

    await expect(invokeTool(surface, 'buggy', {})).rejects.toThrow('programmer bug');
  });

  it('returns execution-failed settlement from the LLM boundary for non-abort executor exceptions', async () => {
    const surface = buildInvocationSurfaceFixture('analyst', [{
      providerName: 'buggy',
      tools: [
        defineTool({
          name: 'buggy',
          description: 'Buggy tool.',
          resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
          inputSchema: z.object({}).strict(),
          executor: async () => { throw new Error('programmer bug'); },
        }),
      ],
    }]);

    await expect(invokeToolForLlm(surface, 'buggy', {}, testLlmToolInvocationContext({ toolName: 'buggy' }))).resolves.toEqual(syntheticToolSettlement('execution_failed', 'programmer bug'));
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
      tools: [defineTool({ name: 'publish', description: 'Publish.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({}).strict(), executor: async () => { throw publicationError; } })],
    }]);

    await expect(invokeToolForLlm(surface, 'publish', {}, testLlmToolInvocationContext({ toolName: 'publish' }))).rejects.toBe(publicationError);
  });

  it.each(['fulfill', 'same-reject', 'different-reject'] as const)('gives exact Stop identity priority after abort-ignoring tool %s', async (mode) => {
    let resolve!: (value: ToolExecutionResult<'none'>) => void;
    let reject!: (error: unknown) => void;
    const tool = new Promise<ToolExecutionResult<'none'>>((done, fail) => { resolve = done; reject = fail; });
    const surface = buildInvocationSurfaceFixture('planner', [{ providerName: 'controlled', tools: [defineTool({ name: 'controlled', description: 'controlled', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({}).strict(), executor: () => tool })] }]);
    const controller = new AbortController();
    const interruption = new RuntimeStoppedInterruption();
    const pending = invokeToolForLlm(surface, 'controlled', {}, testLlmToolInvocationContext({ toolName: 'controlled' }), controller.signal);
    await Promise.resolve();
    controller.abort(interruption);
    if (mode === 'fulfill') resolve(executedProviderResult('none', { success: true }));
    else if (mode === 'same-reject') reject(interruption);
    else reject(new Error('different tool failure'));
    await expect(pending).rejects.toBe(interruption);
  });

  it('returns the executed typed settlement for a successful invocation', async () => {
    const surface = buildInvocationSurfaceFixture('analyst', [provider('a')]);

    await expect(invokeToolForLlm(surface, 'demo', { value: 'ok' }, testLlmToolInvocationContext({ toolName: 'demo' }))).resolves.toEqual({
      kind: 'executed',
      execution: { providerResult: { success: true, data: { value: 'ok' } }, evidence: { kind: 'none' } },
    });
  });

  it('exposes no policy members on provider-wire tool definitions', () => {
    const surface = buildInvocationSurfaceFixture('planner', [provider('a')]);

    for (const definition of surfaceToolDefinitions(surface)) {
      expect(Object.hasOwn(definition, 'resultPolicyTemplate')).toBe(false);
      expect(JSON.stringify(definition)).not.toContain('evidenceMode');
      expect(JSON.stringify(definition)).not.toContain('settledAudience');
    }
    expect(surfaceToolDefinitions(surface)).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({
          name: 'demo',
          description: 'Demo tool.',
          parameters: expect.objectContaining({ type: 'object' }),
        }),
      }),
    ]);
  });

  it('derives observational evidence markers from the binder-owned template mode', () => {
    const observational = defineTool({
      name: 'observed',
      description: 'Observational tool.',
      resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      inputSchema: z.object({}).strict(),
      executor: async () => ({ providerResult: { success: true, data: { rows: [1, 2, 3] } }, evidence: { kind: 'observational_result_bytes' } }) as ToolExecutionResult<'observational_query'>,
    });
    expect(observational.resultPolicyTemplate.evidenceMode).toBe('observational_query');
    expect(executedProviderResult('observational_query', { success: true, data: {} })).toEqual({ providerResult: { success: true, data: {} }, evidence: { kind: 'observational_result_bytes' } });
    expect(executedProviderResult('observational_query', { success: false, error: 'x' })).toEqual({ providerResult: { success: false, error: 'x' }, evidence: { kind: 'none' } });
    expect(executedProviderResult('none', { success: true })).toEqual({ providerResult: { success: true }, evidence: { kind: 'none' } });
  });
});
