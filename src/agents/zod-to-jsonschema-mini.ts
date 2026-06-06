import { z } from 'zod';

export type JsonSchema =
  | { type: 'string'; enum?: string[]; minLength?: number; description?: string }
  | { type: 'number'; description?: string }
  | { type: 'integer'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'null'; description?: string }
  | { type: 'array'; items: JsonSchema; description?: string }
  | { type: 'object'; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean | JsonSchema; description?: string }
  | { const: unknown }
  | { anyOf: JsonSchema[]; description?: string }
  | { description?: string };

function unwrap(schema: z.ZodTypeAny): { node: z.ZodTypeAny; optional: boolean; nullable: boolean } {
  let node: z.ZodTypeAny = schema;
  let optional = false;
  let nullable = false;
  let stripped = true;
  while (stripped) {
    stripped = false;
    const def: { typeName?: string; innerType?: z.ZodTypeAny } | undefined = (node as { _def?: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
    if (!def) break;
    if (def.typeName === 'ZodOptional') {
      optional = true;
      node = def.innerType as z.ZodTypeAny;
      stripped = true;
    } else if (def.typeName === 'ZodDefault') {
      optional = true;
      node = def.innerType as z.ZodTypeAny;
      stripped = true;
    } else if (def.typeName === 'ZodEffects') {
      const inner = (def as unknown as { schema?: z.ZodTypeAny }).schema;
      if (!inner) throw new Error('zodToJsonSchemaMini: ZodEffects with no inner schema');
      node = inner;
      stripped = true;
    }
  }
  // Nullable is handled inside convertNode (wraps anyOf), so detect it here but
  // we strip it out and let convertNode emit the union.
  const def = (node as { _def?: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
  if (def?.typeName === 'ZodNullable') {
    nullable = true;
    node = def.innerType as z.ZodTypeAny;
  }
  return { node, optional, nullable };
}

function convertNode(schema: z.ZodTypeAny): JsonSchema {
  const outerDescription = schema.description;
  const { node, nullable } = unwrap(schema);
  const def = (node as { _def?: Record<string, unknown> })._def;
  const typeName = def?.typeName as string | undefined;
  let out: JsonSchema;

  switch (typeName) {
    case 'ZodString': {
      const checks = (def?.checks as Array<{ kind: string; value?: number }> | undefined) ?? [];
      const minCheck = checks.find((c) => c.kind === 'min');
      out = minCheck && typeof minCheck.value === 'number'
        ? { type: 'string', minLength: minCheck.value }
        : { type: 'string' };
      break;
    }
    case 'ZodNumber': {
      const checks = (def?.checks as Array<{ kind: string }> | undefined) ?? [];
      out = checks.some((c) => c.kind === 'int') ? { type: 'integer' } : { type: 'number' };
      break;
    }
    case 'ZodBoolean':
      out = { type: 'boolean' };
      break;
    case 'ZodArray': {
      const inner = (def?.type ?? def?.innerType) as z.ZodTypeAny | undefined;
      if (!inner) throw new Error('zodToJsonSchemaMini: ZodArray missing element schema');
      out = { type: 'array', items: convertNode(inner) };
      break;
    }
    case 'ZodEnum': {
      const values = (def?.values as string[]) ?? [];
      out = { type: 'string', enum: [...values] };
      break;
    }
    case 'ZodLiteral': {
      out = { const: def?.value };
      break;
    }
    case 'ZodUnknown':
    case 'ZodAny':
      out = {};
      break;
    case 'ZodNull':
      out = { type: 'null' };
      break;
    case 'ZodObject': {
      const shape = (node as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        const { optional } = unwrap(child);
        properties[key] = convertNode(child);
        if (!optional) required.push(key);
      }
      const unknownKeys = def?.unknownKeys as string | undefined;
      const additional: boolean = unknownKeys !== 'strict';
      const obj: JsonSchema = { type: 'object', properties, additionalProperties: additional };
      (obj as { required: string[] }).required = required;
      out = obj;
      break;
    }
    case 'ZodRecord': {
      const valueType = def?.valueType as z.ZodTypeAny | undefined;
      const valueSchema: JsonSchema = valueType ? convertNode(valueType) : {};
      out = { type: 'object', additionalProperties: valueSchema };
      break;
    }
    case 'ZodUnion': {
      const options = (def?.options as z.ZodTypeAny[]) ?? [];
      out = { anyOf: options.map(convertNode) };
      break;
    }
    case 'ZodDiscriminatedUnion': {
      const options = (def?.options as z.ZodTypeAny[]) ?? [];
      out = { anyOf: options.map(convertNode) };
      break;
    }
    default:
      throw new Error(`zodToJsonSchemaMini: unsupported Zod node: ${typeName ?? 'unknown'}`);
  }

  if (nullable) {
    const nullableOut: JsonSchema = { anyOf: [out, { type: 'null' }] };
    if (outerDescription ?? node.description) nullableOut.description = outerDescription ?? node.description;
    return nullableOut;
  }
  if (outerDescription ?? node.description) (out as { description?: string }).description = outerDescription ?? node.description;
  return out;
}

export function zodToJsonSchemaMini(schema: z.ZodTypeAny): JsonSchema {
  return convertNode(schema);
}
