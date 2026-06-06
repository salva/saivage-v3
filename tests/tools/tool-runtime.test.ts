import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { z } from 'zod';

import { defineTool, ToolRuntime } from '../../src/tools/runtime.js';

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo text.',
  input: z.object({ text: z.string() }).strict(),
  output: z.object({ echoed: z.string() }).strict(),
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  roles: ['planner', 'executor'],
  execute: async (_ctx, input) => ({ echoed: input.text }),
});

const badOutputTool = defineTool({
  name: 'bad_output',
  description: 'Returns an invalid output.',
  input: z.object({}).strict(),
  output: z.object({ ok: z.literal(true) }).strict(),
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  roles: ['planner'],
  execute: async () => ({ ok: false }),
});

const deleteTool = defineTool({
  name: 'delete_test_card',
  description: 'Delete test card.',
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ success: z.boolean() }).strict(),
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  roles: ['planner', 'analyst'],
  execute: async () => ({ success: true }),
});

describe('ToolRuntime', () => {
  it('returns schema metadata from the typed definitions', () => {
    const runtime = new ToolRuntime({}, [echoTool]);
    expect(runtime.schema()).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: 'echo' }), roles: ['planner', 'executor'] })]);
    expect(runtime.toolNamesForRole('executor')).toEqual(['echo']);
  });

  it('rejects invalid input before execution', async () => {
    const runtime = new ToolRuntime({}, [echoTool]);
    const result = await runtime.invoke({ name: 'echo', input: { text: 5 }, role: 'planner', correlationId: 'call-1', projectRoot: process.cwd() });
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ kind: 'ToolInputRejected' }) }));
  });

  it('rejects roles that are not listed on the tool definition', async () => {
    const runtime = new ToolRuntime({}, [echoTool]);
    const result = await runtime.invoke({ name: 'echo', input: { text: 'hello' }, role: 'reviewer', correlationId: 'call-2', projectRoot: process.cwd() });
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ kind: 'ToolRoleRejected' }) }));
  });

  it('does not apply card permissions outside context-rich tool boundaries', async () => {
    const runtime = new ToolRuntime({}, [deleteTool]);
    const result = await runtime.invoke({ name: 'delete_test_card', input: { id: 'card-1' }, role: 'planner', correlationId: 'call-3', projectRoot: process.cwd() });
    expect(result).toEqual({ ok: true, output: { success: true } });
  });

  it('validates output and emits boundary audit events', async () => {
    const bus = new EventEmitter();
    const events: string[] = [];
    bus.on('tool_invoked', () => events.push('tool_invoked'));
    bus.on('runtime_actionable_error', () => events.push('runtime_actionable_error'));
    bus.on('tool_failed', () => events.push('tool_failed'));
    const runtime = new ToolRuntime({ bus }, [badOutputTool]);
    const result = await runtime.invoke({ name: 'bad_output', input: {}, role: 'planner', correlationId: 'call-4', projectRoot: process.cwd() });
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ kind: 'ToolContractViolation' }) }));
    expect(events).toEqual(['tool_invoked', 'runtime_actionable_error', 'tool_failed']);
  });
});
