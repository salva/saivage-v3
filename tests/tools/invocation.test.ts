import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { composeInvocationSurface, defineTool, invokeTool, invokeToolForLlm, surfaceToolDefinitions, type ToolProvider, type ToolResult } from '../../src/tools/invocation.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { AppLogPublicationError } from '../../src/persistence/app-log.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';

describe('tool invocation surface', () => {
  const provider = (providerName: string, toolName = 'demo'): ToolProvider => ({
    providerName,
    tools: [
      defineTool({
        name: toolName,
        description: 'Demo tool.',
        inputSchema: z.object({ value: z.string() }).strict(),
        executor: async (args) => ({ success: true, data: { value: args.value } }),
      }),
    ],
  });

  it('throws on duplicate provider tool names during production composition', () => {
    expect(() => composeInvocationSurface('executor', ['demo'], [provider('a'), provider('b')])).toThrow("Duplicate tool 'demo' from provider 'b'.");
  });

  it('composes requested tools and provider projections in their contract orders', () => {
    const firstProvider = provider('a', 'first');
    const secondProvider: ToolProvider = {
      providerName: 'b',
      tools: [provider('b', 'second').tools[0]!, provider('b', 'fourth').tools[0]!],
    };
    const surface = composeInvocationSurface('executor', ['fourth', 'second', 'first'], [firstProvider, secondProvider, provider('unused', 'third')]);

    expect([...surface.tools.keys()]).toEqual(['fourth', 'second', 'first']);
    expect(surface.providers.map(({ providerName }) => providerName)).toEqual(['a', 'b']);
    expect(surface.providers.map(({ tools }) => tools.map(({ name }) => name))).toEqual([['first'], ['fourth', 'second']]);
  });

  it('rejects unknown and duplicate requested tool names', () => {
    expect(() => composeInvocationSurface('executor', ['missing'], [provider('a')])).toThrow("Unknown requested tool 'missing'.");
    expect(() => composeInvocationSurface('executor', ['demo', 'demo'], [provider('a')])).toThrow("Duplicate requested tool 'demo'.");
  });

  it('binds selected-provider cleanup to the original provider', async () => {
    const reasons: unknown[] = [];
    const original: ToolProvider & { readonly marker: string } = {
      ...provider('owned'),
      marker: 'original',
      cleanup(reason) {
        reasons.push({ receiver: this, reason });
      },
    };
    const reason = { kind: 'session_closed' } as const;
    const surface = composeInvocationSurface('executor', ['demo'], [original]);

    await surface.providers[0]!.cleanup?.(reason);

    expect(reasons).toEqual([{ receiver: original, reason }]);
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

    await expect(invokeTool(surface, 'missing', {})).resolves.toEqual({ success: false, error: "Unsupported tool 'missing' for agent 'reviewer'." });
  });

  it('returns model-visible errors for invalid parsed arguments', async () => {
    const surface = buildInvocationSurfaceFixture('executor', [provider('a')]);

    const result = await invokeTool(surface, 'demo', { value: 1 });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Expected string');
  });

  it('does not catch executor exceptions', async () => {
    const surface = buildInvocationSurfaceFixture('executor', [{
      providerName: 'buggy',
      tools: [
        defineTool({
          name: 'buggy',
          description: 'Buggy tool.',
          inputSchema: z.object({}).strict(),
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
          executor: async () => { throw new Error('programmer bug'); },
        }),
      ],
    }]);

    await expect(invokeToolForLlm(surface, 'buggy', {}, testLlmToolInvocationContext({ toolName: 'buggy' }))).resolves.toEqual({ success: false, error: 'programmer bug' });
  });

  it('rethrows from the LLM boundary when the signal is already aborted', async () => {
    const surface = buildInvocationSurfaceFixture('analyst', [provider('a')]);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(invokeToolForLlm(surface, 'demo', { value: 'ok' }, testLlmToolInvocationContext({ toolName: 'demo' }), controller.signal)).rejects.toThrow('cancelled');
  });

  it('rethrows app-log publication failures unchanged from the LLM boundary', async () => {
    const publicationError = new AppLogPublicationError('event', new Error('append failed'));
    const surface = buildInvocationSurfaceFixture('analyst', [{
      providerName: 'publication',
      tools: [defineTool({ name: 'publish', description: 'Publish.', inputSchema: z.object({}).strict(), executor: async () => { throw publicationError; } })],
    }]);

    await expect(invokeToolForLlm(surface, 'publish', {}, testLlmToolInvocationContext({ toolName: 'publish' }))).rejects.toBe(publicationError);
  });

  it.each(['fulfill', 'same-reject', 'different-reject'] as const)('gives exact Stop identity priority after abort-ignoring tool %s', async (mode) => {
    let resolve!: (value: ToolResult) => void;
    let reject!: (error: unknown) => void;
    const tool = new Promise<ToolResult>((done, fail) => { resolve = done; reject = fail; });
    const surface = buildInvocationSurfaceFixture('planner', [{ providerName: 'controlled', tools: [defineTool({ name: 'controlled', description: 'controlled', inputSchema: z.object({}).strict(), executor: () => tool })] }]);
    const controller = new AbortController();
    const interruption = new RuntimeStoppedInterruption();
    const pending = invokeToolForLlm(surface, 'controlled', {}, testLlmToolInvocationContext({ toolName: 'controlled' }), controller.signal);
    await Promise.resolve();
    controller.abort(interruption);
    if (mode === 'fulfill') resolve({ success: true });
    else if (mode === 'same-reject') reject(interruption);
    else reject(new Error('different tool failure'));
    await expect(pending).rejects.toBe(interruption);
  });

  it('projects invocation surface tools to LLM tool definitions', () => {
    const surface = buildInvocationSurfaceFixture('planner', [provider('a')]);

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
});
