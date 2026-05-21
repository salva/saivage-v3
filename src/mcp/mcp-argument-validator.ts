import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';

export interface McpArgumentValidationFailure {
  type: 'schema_missing' | 'schema_unsupported' | 'schema_compile_error' | 'validation_error';
  diagnostics: Array<Record<string, unknown>>;
}

export type McpArgumentValidationResult =
  | { ok: true }
  | ({ ok: false } & McpArgumentValidationFailure);

export type CachedMcpArgumentValidator =
  | { ok: true; fingerprint: string; validate: ValidateFunction }
  | ({ ok: false; fingerprint: string } & McpArgumentValidationFailure);

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  strict: false,
  validateSchema: true,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function fingerprintMcpInputSchema(schema: unknown): string {
  return createHash('sha256').update(stableJson(schema)).digest('hex');
}

const MAX_DIAGNOSTIC_STRING_LENGTH = 120;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 8;

function truncateDiagnosticString(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}…`;
}

function boundedPrimitive(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string') {
    return truncateDiagnosticString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  return undefined;
}

function boundedPrimitiveArray(values: unknown[]): Array<string | number | boolean | null> {
  const bounded: Array<string | number | boolean | null> = [];
  for (const value of values) {
    const safeValue = boundedPrimitive(value);
    if (safeValue !== undefined) {
      bounded.push(safeValue);
    }
    if (bounded.length >= MAX_DIAGNOSTIC_ARRAY_ITEMS) {
      break;
    }
  }
  return bounded;
}

function safeSchemaDiagnostic(
  type: McpArgumentValidationFailure['type'],
  detail: string,
): McpArgumentValidationFailure {
  return {
    type,
    diagnostics: [{ detail: truncateDiagnosticString(detail) }],
  };
}

function schemaRootProblem(schema: unknown): McpArgumentValidationFailure | null {
  if (!isPlainObject(schema)) {
    return safeSchemaDiagnostic('schema_missing', 'inputSchema must be a JSON Schema object');
  }
  if (schema.type !== 'object') {
    return safeSchemaDiagnostic('schema_unsupported', "inputSchema root type must be 'object'");
  }
  return null;
}

function toJsonPointer(instancePath: string): string {
  return instancePath === '' ? '/' : instancePath;
}

function safeValidationDiagnostic(error: ErrorObject): Record<string, unknown> {
  const diagnostic: Record<string, unknown> = {
    path: truncateDiagnosticString(toJsonPointer(error.instancePath)),
    keyword: truncateDiagnosticString(error.keyword),
  };

  if (typeof error.message === 'string') {
    diagnostic.message = truncateDiagnosticString(error.message);
  }

  const params = error.params as Record<string, unknown>;
  if (typeof params.missingProperty === 'string') {
    diagnostic.missingProperty = truncateDiagnosticString(params.missingProperty);
  }
  if (typeof params.type === 'string') {
    diagnostic.expectedType = truncateDiagnosticString(params.type);
  }
  if (typeof params.additionalProperty === 'string') {
    diagnostic.additionalProperty = '<argument-property>';
  }
  if (Array.isArray(params.allowedValues)) {
    diagnostic.allowedValues = boundedPrimitiveArray(params.allowedValues);
  }
  if (typeof params.limit === 'number') {
    diagnostic.limit = params.limit;
  }
  if (typeof params.comparison === 'string') {
    diagnostic.comparison = truncateDiagnosticString(params.comparison);
  }
  if (typeof params.pattern === 'string') {
    diagnostic.pattern = truncateDiagnosticString(params.pattern);
  }

  return diagnostic;
}

export function compileMcpArgumentValidator(schema: unknown): CachedMcpArgumentValidator {
  const fingerprint = fingerprintMcpInputSchema(schema);
  const rootProblem = schemaRootProblem(schema);
  if (rootProblem) {
    return { ok: false, fingerprint, ...rootProblem };
  }

  try {
    const validate = ajv.compile(schema as AnySchema);
    return { ok: true, fingerprint, validate };
  } catch (err) {
    return {
      ok: false,
      fingerprint,
      ...safeSchemaDiagnostic(
        'schema_compile_error',
        err instanceof Error ? err.message : 'inputSchema could not be compiled',
      ),
    };
  }
}

export function validateMcpArguments(
  compiled: CachedMcpArgumentValidator,
  args: Record<string, unknown>,
): McpArgumentValidationResult {
  if (!compiled.ok) {
    return {
      ok: false,
      type: compiled.type,
      diagnostics: compiled.diagnostics,
    };
  }

  const valid = compiled.validate(args);
  if (valid) {
    return { ok: true };
  }

  return {
    ok: false,
    type: 'validation_error',
    diagnostics: (compiled.validate.errors ?? []).slice(0, 8).map(safeValidationDiagnostic),
  };
}
