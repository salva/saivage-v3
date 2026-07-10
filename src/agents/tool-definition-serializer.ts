import type { ToolDefinition } from './llm-contracts.js';

export type RuntimeToolEntry = ToolDefinition;

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

export interface WireToolDefinitionResponses {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

interface ProjectedFields {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

function assertProjectableEntry(tool: unknown, index: number): ProjectedFields {
  if (tool === null || typeof tool !== 'object') {
    throw new Error(`tool-definition-serializer: tools[${index}] must be an object`);
  }
  const obj = tool as { type?: unknown; function?: unknown };
  if (obj.type !== 'function') {
    throw new Error(`tool-definition-serializer: tools[${index}].type must be 'function'`);
  }
  const fn = obj.function;
  if (fn === null || typeof fn !== 'object') {
    throw new Error(`tool-definition-serializer: tools[${index}].function must be an object`);
  }
  const fnObj = fn as { name?: unknown; description?: unknown; parameters?: unknown };
  if (typeof fnObj.name !== 'string' || fnObj.name.length === 0) {
    throw new Error(`tool-definition-serializer: tools[${index}].function.name must be a non-empty string`);
  }
  if (typeof fnObj.description !== 'string' || fnObj.description.length === 0) {
    throw new Error(`tool-definition-serializer: tools[${index}].function.description must be a non-empty string`);
  }
  if (fnObj.parameters === null || typeof fnObj.parameters !== 'object' || Array.isArray(fnObj.parameters)) {
    throw new Error(`tool-definition-serializer: tools[${index}].function.parameters must be a JSON-schema object`);
  }
  return { name: fnObj.name, description: fnObj.description, parameters: fnObj.parameters as Record<string, unknown> };
}

function assertNonEmpty(tools: readonly unknown[]): void {
  if (!Array.isArray(tools)) {
    throw new Error('tool-definition-serializer: tools must be an array');
  }
  if (tools.length === 0) {
    throw new Error('tool-definition-serializer: tools must not be empty');
  }
}

export function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

export function serializeToolsForChat(tools: readonly RuntimeToolEntry[]): readonly WireToolDefinitionChat[] {
  assertNonEmpty(tools);
  const wire = tools.map((tool, i) => {
    const projected = assertProjectableEntry(tool, i);
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

export function serializeToolsForCodex(tools: readonly RuntimeToolEntry[]): readonly WireToolDefinitionCodex[] {
  assertNonEmpty(tools);
  const wire = tools.map((tool, i) => {
    const projected = assertProjectableEntry(tool, i);
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

export function serializeToolsForResponses(tools: readonly RuntimeToolEntry[]): readonly WireToolDefinitionResponses[] {
  return serializeToolsForCodex(tools);
}
