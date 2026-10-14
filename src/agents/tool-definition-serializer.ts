import type { ToolDefinition } from '../contracts/index.js';

export interface WireToolDefinitionChat {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface WireToolDefinitionCodex {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

export function serializeToolsForChat(
  tools: readonly ToolDefinition[],
): readonly WireToolDefinitionChat[] {
  const wire = tools.map((tool) => {
    const projected = tool.function;
    const parameters = deepFreezeJson(projected.parameters);
    return Object.freeze({
      type: 'function' as const,
      function: Object.freeze({
        name: projected.name,
        description: projected.description,
        parameters,
      }),
    });
  });
  return Object.freeze(wire);
}

export function serializeToolsForCodex(
  tools: readonly ToolDefinition[],
): readonly WireToolDefinitionCodex[] {
  const wire = tools.map((tool) => {
    const projected = tool.function;
    const parameters = deepFreezeJson(projected.parameters);
    return Object.freeze({
      type: 'function' as const,
      name: projected.name,
      description: projected.description,
      parameters,
    });
  });
  return Object.freeze(wire);
}
