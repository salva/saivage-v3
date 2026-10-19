import type {
  OperationDefinition,
  OperationField,
  OperationFields,
  OperationValues,
  OperationReturn,
} from './operation-contract.js';
import {
  operationIdSchema,
  validateOperationFields,
  validateOperationValues,
  validateOperationReturn,
} from './operation-contract.js';

type InputBinding = Readonly<
  | { literal: import('./operation-contract.js').OperationValue }
  | { source: 'card_id' | 'card_type' | 'card_title' | 'committed_status' }
>;
export type InputBindings = Readonly<Record<string, InputBinding>>;
export type EdgeInputs = Readonly<Record<string, Readonly<{ output: string }>>>;
export function compileInputBindings(bindings: InputBindings): InputBindings {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(bindings).map(([name, binding]) => [
        name,
        Object.freeze(
          'literal' in binding
            ? {
                literal: Array.isArray(binding.literal)
                  ? Object.freeze([...binding.literal])
                  : binding.literal,
              }
            : { ...binding },
        ),
      ]),
    ),
  ) as InputBindings;
}
export type RouteTest = Readonly<{
  field: string;
  op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: string | boolean | number;
}>;
export interface CompiledActionExecution {
  readonly kind: 'action';
  readonly operation: OperationDefinition;
  readonly config: unknown;
  readonly inputs: InputBindings;
}
export function compileActionExecution(
  source: { action: string; contract_version: number; config?: unknown; inputs: InputBindings },
  operations: ReadonlyMap<string, OperationDefinition>,
  binding: 'node' | 'after_activation_commit',
): CompiledActionExecution {
  operationIdSchema.parse(source.action);
  const operation = operations.get(source.action);
  if (!operation) throw new Error(`Unresolved operation '${source.action}'.`);
  if (source.contract_version !== operation.contractVersion)
    throw new Error(`Unsupported contract for '${source.action}'.`);
  if (!operation.bindings.includes(binding))
    throw new Error(`Operation '${source.action}' does not support '${binding}'.`);
  const config = operation.config.parse(source.config);
  validateInputBindings(operation.inputs, source.inputs, binding === 'after_activation_commit');
  return Object.freeze({
    kind: 'action',
    operation,
    config,
    inputs: compileInputBindings(source.inputs),
  });
}
type WithoutWorkflow<T> = T extends unknown ? Omit<T, 'workflow'> : never;
export function compileDataFields(
  source: Readonly<Record<string, WithoutWorkflow<OperationField>>>,
): OperationFields {
  const fields = Object.fromEntries(
    Object.entries(source).map(([name, field]) => [
      name,
      Object.freeze(
        field.type === 'string' && field.enum
          ? { ...field, enum: Object.freeze([...field.enum]), workflow: true }
          : { ...field, workflow: true },
      ),
    ]),
  );
  validateOperationFields(fields);
  return Object.freeze(fields);
}
export function compileEdgeInputs(source: EdgeInputs | undefined): EdgeInputs {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(source ?? {}).map(([name, binding]) => [name, Object.freeze({ ...binding })]),
    ),
  );
}
export function validateInputBindings(
  fields: OperationFields,
  bindings: InputBindings,
  hook = false,
): void {
  for (const [name, binding] of Object.entries(bindings)) {
    const field = fields[name];
    if (!field) throw new Error(`Unknown input '${name}'.`);
    if ('literal' in binding)
      validateOperationValues({ [name]: field }, { [name]: binding.literal });
    else {
      if (binding.source === 'committed_status' && !hook)
        throw new Error('committed_status is hook-only.');
      if (field.type !== 'string')
        throw new Error(`Factual source '${binding.source}' requires string input '${name}'.`);
      if (field.enum) throw new Error(`Factual source cannot guarantee enum input '${name}'.`);
    }
  }
}
function assignable(source: OperationField, target: OperationField): boolean {
  if (!source.workflow || source.type !== target.type) return false;
  if (source.type === 'integer' && target.type === 'integer')
    return (
      (target.min === undefined || (source.min !== undefined && source.min >= target.min)) &&
      (target.max === undefined || (source.max !== undefined && source.max <= target.max))
    );
  if (source.type === 'string' && target.type === 'string' && target.enum)
    return source.enum !== undefined && source.enum.every((value) => target.enum!.includes(value));
  return true;
}
export function validateIncomingInputs(
  fields: OperationFields,
  base: InputBindings,
  edge: EdgeInputs,
  outputs: OperationFields,
): void {
  for (const [name, binding] of Object.entries(edge)) {
    if (Object.hasOwn(base, name)) throw new Error(`Duplicate supplier for input '${name}'.`);
    const target = fields[name];
    const source = outputs[binding.output];
    if (!target || !source || !assignable(source, target))
      throw new Error(`Invalid output binding '${binding.output}' to '${name}'.`);
  }
  for (const name of Object.keys(fields))
    if (!Object.hasOwn(base, name) && !Object.hasOwn(edge, name))
      throw new Error(`Missing required input '${name}'.`);
}
export function validateRouteTest(test: RouteTest, fields: OperationFields): void {
  const field = fields[test.field];
  if (!field?.workflow) throw new Error(`Case field '${test.field}' is not workflow-safe.`);
  if (test.op !== 'eq' && field.type !== 'integer')
    throw new Error('Ordered comparisons require integer fields.');
  if (field.type === 'strings') throw new Error('Cases cannot compare list fields.');
  validateOperationValues({ [test.field]: field }, { [test.field]: test.value });
}
function routeTestMatches(test: RouteTest, values: OperationValues): boolean {
  const value = values[test.field];
  switch (test.op) {
    case 'eq':
      return value === test.value;
    case 'gt':
      return (value as number) > (test.value as number);
    case 'gte':
      return (value as number) >= (test.value as number);
    case 'lt':
      return (value as number) < (test.value as number);
    case 'lte':
      return (value as number) <= (test.value as number);
  }
}
export function selectOperationRoute(
  execution: CompiledActionExecution,
  routes: readonly Readonly<{ outcome: string; routeId: string; test: RouteTest | null }>[],
  raw: unknown,
): Readonly<{ result: OperationReturn; routeId: string }> {
  const result = validateOperationReturn(execution.operation, raw);
  const route = routes.find(
    (candidate) =>
      candidate.outcome === result.outcome &&
      (candidate.test === null || routeTestMatches(candidate.test, result.values)),
  );
  if (!route) throw new Error(`No compiled route for '${result.outcome}'.`);
  return { result, routeId: route.routeId };
}
export function resolveExecutionInputs(
  fields: OperationFields,
  base: InputBindings,
  edge: EdgeInputs,
  values: OperationValues,
  facts: Readonly<{
    card_id: string;
    card_type: string;
    card_title: string;
    committed_status?: string;
  }>,
): OperationValues {
  const resolved: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(base))
    resolved[name] = 'literal' in binding ? binding.literal : facts[binding.source];
  for (const [name, binding] of Object.entries(edge)) {
    if (Object.hasOwn(resolved, name)) throw new Error(`Duplicate supplier for input '${name}'.`);
    resolved[name] = values[binding.output];
  }
  return validateOperationValues(fields, resolved);
}
