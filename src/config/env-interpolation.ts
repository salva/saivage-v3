const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface EnvInterpolationResult {
  value: string;
  warnings: string[];
}

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve `${ENV_VAR}` references in a string against the explicit startup env.
 * Unknown variables are replaced with an empty string and recorded as warnings;
 * secret values are never included in warning text.
 */
function interpolateString(raw: string, env: EnvironmentSource): EnvInterpolationResult {
  const warnings: string[] = [];
  const value = raw.replace(ENV_PATTERN, (_match, name: string) => {
    const envVal = env[name];
    if (envVal === undefined) {
      warnings.push(`Environment variable '${name}' is not set.`);
      return '';
    }
    return envVal;
  });
  return { value, warnings };
}

/** Initializers and action config/inputs are literal data, not expansion hosts. */
export function interpolateValue(
  v: unknown,
  env: EnvironmentSource,
  path: readonly string[] = [],
): { value: unknown; warnings: string[] } {
  if (
    path.length === 6 &&
    path[0] === 'card_types' &&
    path[2] === 'records' &&
    path[4] === 'initialization' &&
    path[5] === 'template'
  )
    return { value: v, warnings: [] };
  if (typeof v === 'string') {
    return interpolateString(v, env);
  }
  if (Array.isArray(v)) {
    const results = v.map((item, index) => interpolateValue(item, env, [...path, String(index)]));
    return {
      value: results.map((r) => r.value),
      warnings: results.flatMap((r) => r.warnings),
    };
  }
  if (v !== null && typeof v === 'object') {
    const object = v as Record<string, unknown>;
    const workflowExecution =
      path[0] === 'card_types' &&
      path[2] === 'workflow' &&
      ((path.length === 6 && path[3] === 'nodes' && path[5] === 'execution') ||
        (path.length === 5 && path[3] === 'after_activation_commit' && path[4] === 'execution'));
    const executionKind = workflowExecution
      ? interpolateValue(object.kind, env, [...path, 'kind'])
      : null;
    const actionExecution = executionKind?.value === 'action';
    const result: Record<string, unknown> = {};
    const warnings: string[] = [];
    for (const [key, val] of Object.entries(object)) {
      if (key === 'kind' && executionKind) {
        result[key] = executionKind.value;
        warnings.push(...executionKind.warnings);
        continue;
      }
      if (actionExecution && (key === 'config' || key === 'inputs')) {
        result[key] = val;
        continue;
      }
      const { value: iv, warnings: iw } = interpolateValue(val, env, [...path, key]);
      result[key] = iv;
      warnings.push(...iw);
    }
    return { value: result, warnings };
  }
  return { value: v, warnings: [] };
}
