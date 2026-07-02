import { describe, expect, it } from '@jest/globals';

import {
  serializeToolsForChat,
  serializeToolsForCodex,
  type RuntimeToolEntry,
} from '../../src/agents/tool-definition-serializer.js';

function tool(name: string, description: string, properties: Record<string, unknown> = {}): RuntimeToolEntry {
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
  } as RuntimeToolEntry;
}

const SAMPLE: RuntimeToolEntry[] = [
  tool('glob', 'Search files by glob pattern.', { pattern: { type: 'string' } }),
  tool('create_card', 'Create a direct child card.', { title: { type: 'string' } }),
  tool('skill', 'List or load a skill.', { name: { type: 'string' } }),
];

const ACTIVATE_CARD = tool('activate_card', 'Activate one immediate child card.', { card_id: { type: 'string' } });

const RUNTIME_STYLE = {
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
} as unknown as RuntimeToolEntry;

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
    const raw = wire as unknown as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(['function', 'type']);
    expect(Object.keys(wire.function).sort()).toEqual(['description', 'name', 'parameters']);
    expect(raw.roles).toBeUndefined();
    expect(raw.action).toBeUndefined();
  });

  it('projects runtime entries and strips roles/action for Codex', () => {
    const [wire] = serializeToolsForCodex([RUNTIME_STYLE]);
    const raw = wire as unknown as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(['description', 'name', 'parameters', 'type']);
    expect(raw.roles).toBeUndefined();
    expect(raw.action).toBeUndefined();
    expect(raw.function).toBeUndefined();
  });

  it('rejects empty arrays', () => {
    expect(() => serializeToolsForChat([])).toThrow(/must not be empty/);
    expect(() => serializeToolsForCodex([])).toThrow(/must not be empty/);
  });

  it('rejects malformed entries (missing name) with a clear message', () => {
    expect(() =>
      serializeToolsForChat([
        { type: 'function', function: { description: 'd', parameters: {} } } as unknown as RuntimeToolEntry,
      ]),
    ).toThrow(/name must be a non-empty string/);
    expect(() =>
      serializeToolsForCodex([
        { type: 'function', function: { description: 'd', parameters: {} } } as unknown as RuntimeToolEntry,
      ]),
    ).toThrow(/name must be a non-empty string/);
  });

  it('rejects empty name / missing description / non-object parameters', () => {
    expect(() =>
      serializeToolsForChat([
        { type: 'function', function: { name: '', description: 'd', parameters: {} } } as unknown as RuntimeToolEntry,
      ]),
    ).toThrow(/name must be a non-empty string/);
    expect(() =>
      serializeToolsForChat([
        { type: 'function', function: { name: 'n', description: '', parameters: {} } } as unknown as RuntimeToolEntry,
      ]),
    ).toThrow(/description must be a non-empty string/);
    expect(() =>
      serializeToolsForCodex([
        { type: 'function', function: { name: 'n', description: 'd', parameters: null } } as unknown as RuntimeToolEntry,
      ]),
    ).toThrow(/parameters must be a JSON-schema object/);
    expect(() =>
      serializeToolsForCodex([
        { type: 'function', function: { name: 'n', description: 'd', parameters: [] } } as unknown as RuntimeToolEntry,
      ]),
    ).toThrow(/parameters must be a JSON-schema object/);
  });

  it('rejects non-function type', () => {
    expect(() =>
      serializeToolsForChat([
        { type: 'custom', function: { name: 'n', description: 'd', parameters: {} } } as unknown as RuntimeToolEntry,
      ]),
    ).toThrow(/type must be 'function'/);
  });

  it('deep-freezes Chat wire wrapper, function envelope, and parameters subtree', () => {
    const [first] = serializeToolsForChat(SAMPLE);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.function)).toBe(true);
    expect(Object.isFrozen(first.function.parameters)).toBe(true);
    const props = (first.function.parameters as { properties?: Record<string, unknown> }).properties;
    if (props) expect(Object.isFrozen(props)).toBe(true);
    expect(() => {
      (first.function.parameters as Record<string, unknown>).injected = 'x';
    }).toThrow(TypeError);
  });

  it('deep-freezes Codex wire entries', () => {
    const [firstCodex] = serializeToolsForCodex(SAMPLE);
    expect(Object.isFrozen(firstCodex)).toBe(true);
    expect(Object.isFrozen(firstCodex.parameters)).toBe(true);
    expect(() => {
      (firstCodex.parameters as unknown as Record<string, unknown>).injected = 'x';
    }).toThrow(TypeError);
  });
});
