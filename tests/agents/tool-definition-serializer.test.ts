import { describe, expect, it } from '@jest/globals';

import {
  serializeToolsForChat,
  serializeToolsForCodex,
} from '../../src/agents/tool-definition-serializer.js';
import type { ToolDefinition } from '../../src/contracts/index.js';

function tool(name: string, description: string, properties: Record<string, unknown> = {}): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required: [],
        additionalProperties: false,
      },
    },
  };
}

const SAMPLE: ToolDefinition[] = [
  tool('glob', 'Search files by glob pattern.', { pattern: { type: 'string' } }),
  tool('create_card', 'Create a direct child card.', { title: { type: 'string' } }),
  tool('skill', 'List or load a skill.', { name: { type: 'string' } }),
];

const ACTIVATE_CARD = tool('activate_card', 'Activate one immediate child card.', { card_id: { type: 'string' }, instructions: { type: 'string', pattern: '\\S' } });

const RUNTIME_STYLE: ToolDefinition & { roles: string[]; action: string } = {
  type: 'function',
  function: {
    name: 'runtime_demo',
    description: 'runtime-backed tool',
    parameters: {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
      additionalProperties: false,
    },
  },
  roles: ['planner', 'executor'],
  action: 'plan',
};

describe('tool-definition-serializer', () => {
  it('snapshots Chat wire shape for a planner tool (activate_card)', () => {
    expect(serializeToolsForChat([ACTIVATE_CARD])).toMatchSnapshot();
  });

  it('snapshots Codex wire shape for a planner tool (activate_card)', () => {
    expect(serializeToolsForCodex([ACTIVATE_CARD])).toMatchSnapshot();
  });

  it('snapshots Chat wire shape for sample catalog tools', () => {
    expect(serializeToolsForChat(SAMPLE)).toMatchSnapshot();
  });

  it('snapshots Codex wire shape for sample catalog tools', () => {
    expect(serializeToolsForCodex(SAMPLE)).toMatchSnapshot();
  });

  it('projects runtime entries and strips roles/action for Chat', () => {
    const [wire] = serializeToolsForChat([RUNTIME_STYLE]);
    expect(Object.keys(wire).sort()).toEqual(['function', 'type']);
    expect(Object.keys(wire.function).sort()).toEqual(['description', 'name', 'parameters']);
    expect(wire).not.toHaveProperty('roles');
    expect(wire).not.toHaveProperty('action');
  });

  it('projects runtime entries and strips roles/action for Codex', () => {
    const [wire] = serializeToolsForCodex([RUNTIME_STYLE]);
    expect(Object.keys(wire).sort()).toEqual(['description', 'name', 'parameters', 'type']);
    expect(wire).not.toHaveProperty('roles');
    expect(wire).not.toHaveProperty('action');
    expect(wire).not.toHaveProperty('function');
  });

  it('deep-freezes Chat wire wrapper, function envelope, and parameters subtree', () => {
    const properties = { x: { type: 'string', enum: ['a', 'b'] } };
    const input = tool('fresh', 'Fresh schema', properties);
    const wire = serializeToolsForChat([input]);
    const [first] = wire;
    expect(Object.isFrozen(wire)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.function)).toBe(true);
    expect(first.function.parameters).toBe(input.function.parameters);
    expect(Object.isFrozen(first.function.parameters)).toBe(true);
    expect(Object.isFrozen(properties)).toBe(true);
    expect(Object.isFrozen(properties.x)).toBe(true);
    expect(Object.isFrozen(properties.x.enum)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.function)).toBe(false);
    expect(() => {
      input.function.parameters.injected = 'x';
    }).toThrow(TypeError);
  });

  it('deep-freezes Codex wire entries', () => {
    const properties = { x: { type: 'string', enum: ['a', 'b'] } };
    const input = tool('fresh', 'Fresh schema', properties);
    const wire = serializeToolsForCodex([input]);
    const [firstCodex] = wire;
    expect(Object.isFrozen(wire)).toBe(true);
    expect(Object.isFrozen(firstCodex)).toBe(true);
    expect(firstCodex.parameters).toBe(input.function.parameters);
    expect(Object.isFrozen(firstCodex.parameters)).toBe(true);
    expect(Object.isFrozen(properties)).toBe(true);
    expect(Object.isFrozen(properties.x)).toBe(true);
    expect(Object.isFrozen(properties.x.enum)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.function)).toBe(false);
    expect(() => {
      input.function.parameters.injected = 'x';
    }).toThrow(TypeError);
  });
});
