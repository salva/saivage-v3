import { z } from 'zod';
import {
  operationIdSchema,
  operationKeySchema,
  operationNamespaceSchema,
} from '../../schemas/index.js';
import { operationOutputSourceSchema, type OperationOutputSource } from '../../schemas/index.js';

const outcomeSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const fieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u);
const operationValueSchema = z.union([
  z.string().refine((value) => Buffer.byteLength(value) <= 4096, 'String exceeds 4096 bytes.'),
  z.boolean(),
  z.number().int().safe(),
  z.array(z.string().refine((value) => Buffer.byteLength(value) <= 4096)).max(256),
]);
export type OperationValue = string | boolean | number | readonly string[];
export type OperationValues = Readonly<Record<string, OperationValue>>;
type OperationBindingKind = 'node' | 'after_activation_commit';
export type OperationField = Readonly<
  | { type: 'string'; enum?: readonly string[]; workflow: boolean }
  | { type: 'integer'; min?: number; max?: number; workflow: boolean }
  | { type: 'boolean'; workflow: boolean }
  | { type: 'strings'; workflow: boolean }
>;
export type OperationFields = Readonly<Record<string, OperationField>>;
export interface OperationReturn {
  readonly outcome: string;
  readonly summary: string;
  readonly values: OperationValues;
}

/** Private completed bytes are not flat routing fields or publication authority. */
interface OperationRunResult {
  readonly result: OperationReturn;
  readonly output: Uint8Array | null;
}

/** Capabilities are supplied explicitly by the invocation owner, never a service bag. */
interface OperationCapabilities {
  readonly invocationId: string;
  readonly projectRoot?: string;
  readonly resolveReadablePath?: (projectRelativePath: string) => string;
  /** Exact host-selected settled capture, not a caller-supplied file path. */
  readonly readCommandStdout?: () => Uint8Array;
  readonly readFile?: (projectRelativePath: string) => string;
  readonly command?: (
    input: {
      script: string;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
      timeoutMs: number;
      terminateGraceMs: number;
    },
    signal: AbortSignal,
  ) => Promise<OperationReturn>;
}
export interface OperationDefinition<Config = unknown> {
  readonly id: string;
  readonly provider: Readonly<{ kind: 'builtin' | 'plugin'; name: string }>;
  readonly contractVersion: 1;
  readonly bindings: readonly OperationBindingKind[];
  readonly config: z.ZodType<Config, z.ZodTypeDef, unknown>;
  readonly inputs: OperationFields;
  readonly outcomes: Readonly<Record<string, OperationFields>>;
  readonly retainFields: readonly string[];
  readonly output: OperationOutputSource | null;
  artifacts(config: Config, invocationId: string): readonly string[];
  run(
    config: Config,
    input: OperationValues,
    capabilities: OperationCapabilities,
    signal: AbortSignal,
  ): Promise<OperationRunResult>;
}
export interface OperationPlugin {
  readonly namespace: string;
  readonly operations: Readonly<Record<string, OperationDefinition>>;
}

export function validateOperationFields(fields: OperationFields): void {
  if (Object.keys(fields).length > 32) throw new Error('Operation declares more than 32 fields.');
  for (const [name, field] of Object.entries(fields)) {
    fieldNameSchema.parse(name);
    if (typeof field.workflow !== 'boolean')
      throw new Error(`Field '${name}' needs workflow visibility.`);
    switch (field.type) {
      case 'string':
        if (field.enum) {
          if (field.enum.length === 0 || new Set(field.enum).size !== field.enum.length)
            throw new Error(`Field '${name}' has an empty or duplicate enum.`);
          for (const value of field.enum) {
            if (typeof value !== 'string')
              throw new Error(`Field '${name}' enum must contain strings.`);
            operationValueSchema.parse(value);
          }
        }
        break;
      case 'integer':
        for (const value of [field.min, field.max])
          if (value !== undefined && !Number.isSafeInteger(value))
            throw new Error(`Field '${name}' range must be safe integers.`);
        if (field.min !== undefined && field.max !== undefined && field.min > field.max)
          throw new Error(`Field '${name}' range is reversed.`);
        break;
      case 'boolean':
      case 'strings':
        break;
      default:
        throw new Error(`Field '${name}' has an unsupported type.`);
    }
  }
}

export function validateOperationValues(fields: OperationFields, value: unknown): OperationValues {
  const values = z.record(fieldNameSchema, operationValueSchema).parse(value);
  if (Buffer.byteLength(JSON.stringify(values)) > 65536)
    throw new Error('Operation values exceed 64KiB.');
  const names = Object.keys(fields);
  if (
    Object.keys(values).length !== names.length ||
    Object.keys(values).some((name) => !Object.hasOwn(fields, name))
  )
    throw new Error('Operation fields must match exactly.');
  for (const name of names) {
    const field = fields[name]!;
    const item = values[name];
    const valid =
      field.type === 'strings'
        ? Array.isArray(item)
        : field.type === 'integer'
          ? typeof item === 'number' &&
            (field.min === undefined || item >= field.min) &&
            (field.max === undefined || item <= field.max)
          : field.type === 'string'
            ? typeof item === 'string' && (!field.enum || field.enum.includes(item))
            : typeof item === 'boolean';
    if (!valid) throw new Error(`Operation field '${name}' does not match its declaration.`);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([name, item]) => [
        name,
        Array.isArray(item) ? Object.freeze([...item]) : item,
      ]),
    ),
  ) as OperationValues;
}

export function validateOperationReturn(
  definition: OperationDefinition,
  value: unknown,
): OperationReturn {
  const result = z
    .object({
      outcome: outcomeSchema,
      summary: z.string().trim().min(1).max(2000),
      values: z.unknown(),
    })
    .strict()
    .parse(value);
  const fields = Object.hasOwn(definition.outcomes, result.outcome)
    ? definition.outcomes[result.outcome]
    : undefined;
  if (!fields)
    throw new Error(
      `Operation '${definition.id}' returned undeclared outcome '${result.outcome}'.`,
    );
  return Object.freeze({ ...result, values: validateOperationValues(fields, result.values) });
}

function freezeDefinition(definition: OperationDefinition): OperationDefinition {
  operationIdSchema.parse(definition.id);
  if (definition.contractVersion !== 1)
    throw new Error(`Unsupported operation contract for '${definition.id}'.`);
  if (!definition.provider.name) throw new Error('Operation provider must have an exact name.');
  operationOutputSourceSchema.nullable().parse(definition.output);
  if (
    definition.bindings.length === 0 ||
    new Set(definition.bindings).size !== definition.bindings.length ||
    definition.bindings.some(
      (binding) => binding !== 'node' && binding !== 'after_activation_commit',
    )
  )
    throw new Error(`Operation '${definition.id}' has invalid bindings.`);
  validateOperationFields(definition.inputs);
  if (Object.keys(definition.outcomes).length === 0)
    throw new Error('Operation needs a named outcome.');
  for (const [outcome, fields] of Object.entries(definition.outcomes)) {
    outcomeSchema.parse(outcome);
    validateOperationFields(fields);
  }
  if (
    definition.retainFields.length > 32 ||
    new Set(definition.retainFields).size !== definition.retainFields.length
  )
    throw new Error('Invalid retained operation fields.');
  for (const name of definition.retainFields) {
    const declarations = Object.values(definition.outcomes).flatMap((fields) =>
      Object.hasOwn(fields, name) ? [fields[name]!] : [],
    );
    if (declarations.length === 0 || declarations.some((field) => !field.workflow))
      throw new Error(`Retained field '${name}' must be declared and workflow-safe.`);
  }
  const freezeFields = (fields: OperationFields): OperationFields =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          Object.freeze(
            field.type === 'string' && field.enum
              ? { ...field, enum: Object.freeze([...field.enum]) }
              : { ...field },
          ),
        ]),
      ),
    );
  return Object.freeze({
    ...definition,
    provider: Object.freeze({ ...definition.provider }),
    bindings: Object.freeze([...definition.bindings]),
    inputs: freezeFields(definition.inputs),
    outcomes: Object.freeze(
      Object.fromEntries(
        Object.entries(definition.outcomes).map(([name, fields]) => [name, freezeFields(fields)]),
      ),
    ),
    retainFields: Object.freeze([...definition.retainFields]),
  });
}

export function validateOperationRunResult(
  definition: OperationDefinition,
  value: unknown,
): OperationRunResult {
  const completed = z
    .object({ result: z.unknown(), output: z.instanceof(Uint8Array).nullable() })
    .strict()
    .parse(value);
  const result = validateOperationReturn(definition, completed.result);
  if (definition.output === 'returned-text') {
    if (completed.output === null) throw new Error('Returned-text operation omitted its output.');
    if (completed.output.byteLength > 1024 * 1024)
      throw new Error('Operation output exceeds 1MiB.');
    const bytes = Uint8Array.from(completed.output);
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!content.trim() || content.includes('\0'))
      throw new Error('Operation output must be substantive text without NUL.');
    return Object.freeze({ result, output: bytes });
  }
  if (completed.output !== null)
    throw new Error('Only returned-text operations may supply output bytes.');
  return Object.freeze({ result, output: null });
}

/** Explicit compiled declarations only. The mutable map never escapes this closure. */
export function compileOperations(
  builtins: readonly OperationDefinition[],
  plugins: readonly OperationPlugin[] = [],
): ReadonlyMap<string, OperationDefinition> {
  const reserved = new Set(['shell', 'git', 'saivage']);
  const namespaces = new Set<string>();
  const definitions: OperationDefinition[] = [];
  const ids = new Set<string>();
  const add = (definition: OperationDefinition): void => {
    if (ids.has(definition.id)) throw new Error(`Duplicate operation '${definition.id}'.`);
    ids.add(definition.id);
    definitions.push(freezeDefinition(definition));
  };
  for (const definition of builtins) {
    const namespace = operationIdSchema.parse(definition.id).split('.')[0]!;
    if (
      !reserved.has(namespace) ||
      definition.provider.kind !== 'builtin' ||
      definition.provider.name !== namespace
    )
      throw new Error('Invalid builtin operation declaration.');
    add(definition);
  }
  for (const plugin of plugins) {
    operationNamespaceSchema.parse(plugin.namespace);
    if (reserved.has(plugin.namespace) || namespaces.has(plugin.namespace))
      throw new Error(`Reserved or duplicate operation namespace '${plugin.namespace}'.`);
    namespaces.add(plugin.namespace);
    for (const [name, definition] of Object.entries(plugin.operations)) {
      operationKeySchema.parse(name);
      if (
        definition.id !== `${plugin.namespace}.${name}` ||
        definition.provider.kind !== 'plugin' ||
        definition.provider.name !== plugin.namespace
      )
        throw new Error(`Plugin operation identity does not match '${plugin.namespace}.${name}'.`);
      add(definition);
    }
  }
  return new CompiledOperations(definitions);
}

class CompiledOperations implements ReadonlyMap<string, OperationDefinition> {
  readonly #map: Map<string, OperationDefinition>;
  constructor(definitions: readonly OperationDefinition[]) {
    this.#map = new Map(definitions.map((definition) => [definition.id, definition]));
    Object.freeze(this);
  }
  get size() {
    return this.#map.size;
  }
  get(id: string) {
    return this.#map.get(id);
  }
  has(id: string) {
    return this.#map.has(id);
  }
  entries() {
    return this.#map.entries();
  }
  keys() {
    return this.#map.keys();
  }
  values() {
    return this.#map.values();
  }
  [Symbol.iterator]() {
    return this.#map[Symbol.iterator]();
  }
  forEach(
    callback: (
      definition: OperationDefinition,
      id: string,
      owner: ReadonlyMap<string, OperationDefinition>,
    ) => void,
    thisArg?: unknown,
  ) {
    for (const [id, definition] of this.#map) callback.call(thisArg, definition, id, this);
  }
}
