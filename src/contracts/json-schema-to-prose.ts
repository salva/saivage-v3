import type { JsonSchema } from '../agents/zod-to-jsonschema-mini.js';

export function jsonSchemaToProse(schema: JsonSchema): string {
  return renderNode(schema, 0).trimEnd();
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function renderNode(node: JsonSchema, depth: number): string {
  if ('anyOf' in node && Array.isArray(node.anyOf)) {
    const parts = node.anyOf.map((opt) => describeType(opt));
    return `one of: ${parts.join(' | ')}`;
  }
  if ('const' in node) {
    return `constant ${JSON.stringify((node as { const: unknown }).const)}`;
  }
  if (!('type' in node)) {
    return 'any';
  }
  switch (node.type) {
    case 'string': {
      const enumValues = (node as { enum?: string[] }).enum;
      if (enumValues && enumValues.length > 0) {
        return `string (one of: ${enumValues.map((v) => `"${v}"`).join(', ')})`;
      }
      return 'string';
    }
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = (node as { items: JsonSchema }).items;
      return `array of ${describeType(items)}`;
    }
    case 'object':
      return renderObject(node as ObjectNode, depth);
  }
}

interface ObjectNode {
  type: 'object';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
}

function renderObject(node: ObjectNode, depth: number): string {
  const props = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const entries = Object.entries(props);
  if (entries.length === 0) return 'object';
  const lines: string[] = ['object with fields:'];
  for (const [key, child] of entries) {
    const marker = required.has(key) ? 'required' : 'optional';
    const desc = describeChild(child, depth + 1);
    lines.push(`${indent(depth + 1)}- ${key} (${marker}): ${desc}`);
  }
  return lines.join('\n');
}

function describeChild(child: JsonSchema, depth: number): string {
  if ('type' in child && child.type === 'object') {
    return renderObject(child as ObjectNode, depth);
  }
  if ('type' in child && child.type === 'array') {
    const items = (child as { items: JsonSchema }).items;
    if ('type' in items && items.type === 'object') {
      return `array of:\n${indent(depth + 1)}${renderObject(items as ObjectNode, depth + 1)}`;
    }
    return `array of ${describeType(items)}`;
  }
  return renderNode(child, depth);
}

function describeType(node: JsonSchema): string {
  if ('anyOf' in node && Array.isArray(node.anyOf)) {
    return node.anyOf.map(describeType).join(' | ');
  }
  if ('const' in node) {
    return JSON.stringify((node as { const: unknown }).const);
  }
  if (!('type' in node)) return 'any';
  switch (node.type) {
    case 'string': {
      const enumValues = (node as { enum?: string[] }).enum;
      return enumValues && enumValues.length > 0
        ? `"${enumValues.join('"|"')}"`
        : 'string';
    }
    case 'array':
      return `array<${describeType((node as { items: JsonSchema }).items)}>`;
    case 'object':
      return 'object';
    default:
      return node.type;
  }
}
