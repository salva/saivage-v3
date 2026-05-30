import { describe, expect, it } from '@jest/globals';

import {
  serializeToolsForChat,
  serializeToolsForCodex,
  type RuntimeToolEntry,
} from '../../src/agents/tool-definition-serializer.js';
import { ALL_TOOL_DEFINITIONS_BY_NAME, PLANNER_TOOL_DEFINITIONS } from '../../src/agents/agent-tool-catalog.js';

const SAMPLE: RuntimeToolEntry[] = [
  ALL_TOOL_DEFINITIONS_BY_NAME.get('list_project_files')!,
  ALL_TOOL_DEFINITIONS_BY_NAME.get('create_card')!,
  ALL_TOOL_DEFINITIONS_BY_NAME.get('load_skill')!,
];

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
    const tool = ALL_TOOL_DEFINITIONS_BY_NAME.get('activate_card')!;
    expect(serializeToolsForChat([tool])).toMatchSnapshot();
  });

  it('snapshots Codex wire shape for a planner tool (activate_card)', () => {
    const tool = ALL_TOOL_DEFINITIONS_BY_NAME.get('activate_card')!;
    expect(serializeToolsForCodex([tool])).toMatchSnapshot();
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

  it('projects the full planner catalog for Chat without throwing', () => {
    const wire = serializeToolsForChat(PLANNER_TOOL_DEFINITIONS);
    expect(wire.length).toBe(PLANNER_TOOL_DEFINITIONS.length);
    for (const t of wire) expect(t.type).toBe('function');
  });

  it('projects the full planner catalog for Codex without throwing', () => {
    const wire = serializeToolsForCodex(PLANNER_TOOL_DEFINITIONS);
    expect(wire.length).toBe(PLANNER_TOOL_DEFINITIONS.length);
    for (const t of wire) {
      expect(t.type).toBe('function');
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.parameters).toBe('object');
    }
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
