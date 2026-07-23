import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { buildInvocationSurface, composeInvocationSurface, defineTool, invokeTool, invokeToolForLlm, surfaceToolDefinitions, type ToolProvider, type ToolResult } from '../../src/tools/invocation.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { AppLogPublicationError } from '../../src/persistence/app-log.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';

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

  it('throws on duplicate tool names during surface construction', () => {
    expect(() => buildInvocationSurface('executor', [provider('a'), provider('b')])).toThrow("Duplicate tool 'demo' from provider 'b'.");
  });

  it('composes exact definitions by requested name and order', () => {
    const surface = composeInvocationSurface('executor', ['second', 'first'], [provider('a', 'first'), provider('b', 'second'), provider('unused', 'third')]);
    expect([...surface.tools.keys()]).toEqual(['second', 'first']);
    expect(surface.providers.map(({ providerName }) => providerName)).toEqual(['a', 'b']);
    expect(() => composeInvocationSurface('executor', ['missing'], [provider('a')])).toThrow("Unknown requested tool 'missing'.");
    expect(() => composeInvocationSurface('executor', ['demo', 'demo'], [provider('a')])).toThrow("Duplicate requested tool 'demo'.");
  });

  it('returns model-visible errors for unsupported tool names', async () => {
    const surface = buildInvocationSurface('reviewer', [provider('a')]);

    await expect(invokeTool(surface, 'missing', {})).resolves.toEqual({ success: false, error: "Unsupported tool 'missing' for agent 'reviewer'." });
  });

  it('returns model-visible errors for invalid parsed arguments', async () => {
    const surface = buildInvocationSurface('executor', [provider('a')]);

    const result = await invokeTool(surface, 'demo', { value: 1 });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Expected string');
  });

  it('does not catch executor exceptions', async () => {
    const surface = buildInvocationSurface('executor', [{
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
    const surface = buildInvocationSurface('analyst', [{
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
    const surface = buildInvocationSurface('analyst', [provider('a')]);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(invokeToolForLlm(surface, 'demo', { value: 'ok' }, testLlmToolInvocationContext({ toolName: 'demo' }), controller.signal)).rejects.toThrow('cancelled');
  });

  it('rethrows app-log publication failures unchanged from the LLM boundary', async () => {
    const publicationError = new AppLogPublicationError('event', new Error('append failed'));
    const surface = buildInvocationSurface('analyst', [{
      providerName: 'publication',
      tools: [defineTool({ name: 'publish', description: 'Publish.', inputSchema: z.object({}).strict(), executor: async () => { throw publicationError; } })],
    }]);

    await expect(invokeToolForLlm(surface, 'publish', {}, testLlmToolInvocationContext({ toolName: 'publish' }))).rejects.toBe(publicationError);
  });

  it.each(['fulfill', 'same-reject', 'different-reject'] as const)('gives exact Stop identity priority after abort-ignoring tool %s', async (mode) => {
    let resolve!: (value: ToolResult) => void;
    let reject!: (error: unknown) => void;
    const tool = new Promise<ToolResult>((done, fail) => { resolve = done; reject = fail; });
    const surface = buildInvocationSurface('planner', [{ providerName: 'controlled', tools: [defineTool({ name: 'controlled', description: 'controlled', inputSchema: z.object({}).strict(), executor: () => tool })] }]);
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
    const surface = buildInvocationSurface('planner', [provider('a')]);

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
