import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { defineTool, invokeTool, invokeToolForLlm, OPERATIONAL_RESULT_POLICY_TEMPLATE, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, surfaceToolDefinitions, syntheticToolSettlement, executedToolOutcome, ToolArgumentValidationError, type ToolExecutionResult, type ToolProvider } from '../../src/tools/invocation.js';
import { toolFailed, toolSucceeded } from '../../src/contracts/tool-result.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { DiscoveryCollectionPositionError } from '../../src/tools/response-packer.js';

describe('tool invocation surface', () => {
  const provider = (providerName: string, toolName = 'demo'): ToolProvider => ({
    providerName,
    tools: [
      defineTool({
        name: toolName,
        description: 'Demo tool.',
        resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
        inputSchema: z.object({ value: z.string() }).strict(),
        executor: async (args) => executedToolOutcome('none', toolSucceeded({ value: args.value })),
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
    const result = settleToolActionOutcome(settlement.kind === 'executed' ? settlement.execution.providerOutcome : settlement.providerOutcome).providerResult;
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

  it('propagates unclassified executor exceptions from the LLM boundary', async () => {
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

    await expect(invokeToolForLlm(surface, 'buggy', {}, testLlmToolInvocationContext({ toolName: 'buggy' }))).rejects.toThrow('programmer bug');
  });

  it('returns a rejected-before-execution settlement when ordinary cancellation precedes executor entry', async () => {
    const surface = buildInvocationSurfaceFixture('analyst', [provider('a')]);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(invokeToolForLlm(surface, 'demo', { value: 'ok' }, testLlmToolInvocationContext({ toolName: 'demo' }), controller.signal)).resolves.toEqual(syntheticToolSettlement('rejected_before_execution', 'Tool execution was cancelled before entry.'));
  });

  it('returns an entered tool result after ordinary cancellation instead of discarding known success', async () => {
    let resolve!: (value: ToolExecutionResult<'none'>) => void;
    const tool = new Promise<ToolExecutionResult<'none'>>((done) => { resolve = done; });
    const surface = buildInvocationSurfaceFixture('planner', [{ providerName: 'controlled', tools: [defineTool({ name: 'controlled', description: 'controlled', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({}).strict(), executor: () => tool })] }]);
    const controller = new AbortController();
    const pending = invokeToolForLlm(surface, 'controlled', {}, testLlmToolInvocationContext({ toolName: 'controlled' }), controller.signal);
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    const result = executedToolOutcome('none', toolSucceeded({ retained: true }));
    resolve(result);
    await expect(pending).resolves.toEqual({ kind: 'executed', execution: result });
  });

  it('rethrows app-log publication failures unchanged from the LLM boundary', async () => {
    const publicationError = new PublicationOutcomeUnknownError();
    const surface = buildInvocationSurfaceFixture('analyst', [{
      providerName: 'publication',
      tools: [defineTool({ name: 'publish', description: 'Publish.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({}).strict(), executor: async () => { throw publicationError; } })],
    }]);

    await expect(invokeToolForLlm(surface, 'publish', {}, testLlmToolInvocationContext({ toolName: 'publish' }))).rejects.toBe(publicationError);
  });

  it.each(['fulfill', 'same-reject', 'different-reject'] as const)('preserves returned facts and recognizes only the exact cancellation rejection after entry: %s', async (mode) => {
    let resolve!: (value: ToolExecutionResult<'none'>) => void;
    let reject!: (error: unknown) => void;
    const tool = new Promise<ToolExecutionResult<'none'>>((done, fail) => { resolve = done; reject = fail; });
    const surface = buildInvocationSurfaceFixture('planner', [{ providerName: 'controlled', tools: [defineTool({ name: 'controlled', description: 'controlled', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({}).strict(), executor: () => tool })] }]);
    const controller = new AbortController();
    const interruption = new RuntimeStoppedInterruption();
    const pending = invokeToolForLlm(surface, 'controlled', {}, testLlmToolInvocationContext({ toolName: 'controlled' }), controller.signal);
    await Promise.resolve();
    controller.abort(interruption);
    if (mode === 'fulfill') resolve(executedToolOutcome('none', toolSucceeded()));
    else if (mode === 'same-reject') reject(interruption);
    else reject(new Error('different tool failure'));
    if (mode === 'fulfill') await expect(pending).resolves.toEqual({ kind: 'executed', execution: executedToolOutcome('none', toolSucceeded()) });
    else if (mode === 'same-reject') await expect(pending).resolves.toEqual(syntheticToolSettlement('execution_failed', interruption.message));
    else await expect(pending).rejects.toThrow('different tool failure');
  });

  it.each([
    new ToolArgumentValidationError('scalar section has no collection cursor'),
    new DiscoveryCollectionPositionError(),
  ])('records typed expected failures thrown after executor entry as executed failures', async (failure) => {
    const surface = buildInvocationSurfaceFixture('analyst', [{ providerName: 'expected', tools: [defineTool({
      name: 'observed', description: 'Observed.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      inputSchema: z.object({}).strict(), executor: async () => { throw failure; },
    })] }]);

    const settlement = await invokeToolForLlm(surface, 'observed', {}, testLlmToolInvocationContext({ toolName: 'observed' }));
    expect(settlement.kind).toBe('executed');
    if (settlement.kind !== 'executed') throw new Error('Expected executed settlement.');
    expect(settlement.execution.evidence).toEqual({ kind: 'none' });
    expect(settlement.execution.providerOutcome.kind).toBe('failed');
  });

  it('returns the executed typed settlement for a successful invocation', async () => {
    const surface = buildInvocationSurfaceFixture('analyst', [provider('a')]);

    await expect(invokeToolForLlm(surface, 'demo', { value: 'ok' }, testLlmToolInvocationContext({ toolName: 'demo' }))).resolves.toEqual({
      kind: 'executed',
       execution: { providerOutcome: toolSucceeded({ value: 'ok' }), evidence: { kind: 'none' } },
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
      executor: async () => executedToolOutcome('observational_query', toolSucceeded({ rows: [1, 2, 3] })),
    });
    expect(observational.resultPolicyTemplate.evidenceMode).toBe('observational_query');
    expect(executedToolOutcome('observational_query', toolSucceeded({})).evidence).toEqual({ kind: 'observational_result_bytes' });
    expect(executedToolOutcome('observational_query', toolFailed('x')).evidence).toEqual({ kind: 'none' });
    expect(executedToolOutcome('none', toolSucceeded()).evidence).toEqual({ kind: 'none' });
  });
});
