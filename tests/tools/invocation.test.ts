import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { buildInvocationSurface, defineTool, invokeTool, invokeToolCall, invokeToolForLlm, surfaceToolDefinitions, type ToolProvider, type ToolResult } from '../../src/tools/invocation.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';

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

  it('returns model-visible errors for unsupported tool names', async () => {
    const surface = buildInvocationSurface('reviewer', [provider('a')]);

    await expect(invokeTool(surface, 'missing', {})).resolves.toEqual({ success: false, error: "Unsupported tool 'missing' for role 'reviewer'." });
  });

  it('returns model-visible errors for invalid parsed arguments', async () => {
    const surface = buildInvocationSurface('executor', [provider('a')]);

    const result = await invokeTool(surface, 'demo', { value: 1 });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Expected string');
  });

  it('parses raw JSON tool-call arguments in invokeToolCall', async () => {
    const surface = buildInvocationSurface('executor', [provider('a')]);

    await expect(invokeToolCall(surface, 'demo', JSON.stringify({ value: 'ok' }))).resolves.toEqual({ success: true, data: { value: 'ok' } });
  });

  it('returns model-visible errors for malformed raw JSON arguments', async () => {
    const surface = buildInvocationSurface('executor', [provider('a')]);

    await expect(invokeToolCall(surface, 'demo', '{')).resolves.toEqual({ success: false, error: 'Tool arguments must be valid JSON.' });
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

  it('returns model-visible errors from invokeToolCall for non-abort executor exceptions', async () => {
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

    await expect(invokeToolCall(surface, 'buggy', '{}')).resolves.toEqual({ success: false, error: 'programmer bug' });
  });

  it('rethrows from invokeToolCall when the signal is already aborted', async () => {
    const surface = buildInvocationSurface('analyst', [provider('a')]);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(invokeToolCall(surface, 'demo', JSON.stringify({ value: 'ok' }), controller.signal)).rejects.toThrow('cancelled');
  });

  it.each(['fulfill', 'same-reject', 'different-reject'] as const)('gives exact Stop identity priority after abort-ignoring tool %s', async (mode) => {
    let resolve!: (value: ToolResult) => void;
    let reject!: (error: unknown) => void;
    const tool = new Promise<ToolResult>((done, fail) => { resolve = done; reject = fail; });
    const surface = buildInvocationSurface('planner', [{ providerName: 'controlled', tools: [defineTool({ name: 'controlled', description: 'controlled', inputSchema: z.object({}).strict(), executor: () => tool })] }]);
    const controller = new AbortController();
    const interruption = new RuntimeStoppedInterruption();
    const pending = invokeToolForLlm(surface, 'controlled', {}, controller.signal);
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
