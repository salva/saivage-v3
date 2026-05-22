const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface EnvInterpolationResult {
  value: string;
  warnings: string[];
}

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve `${ENV_VAR}` references in a string against the explicit startup env.
 * Unknown variables are replaced with an empty string and recorded as warnings;
 * secret values are never included in warning text.
 */
export function interpolateString(raw: string, env: EnvironmentSource): EnvInterpolationResult {
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

/** Deep-interpolate ${ENV_VAR} references in any JSON-compatible value. */
export function interpolateValue(v: unknown, env: EnvironmentSource): { value: unknown; warnings: string[] } {
  if (typeof v === 'string') {
    return interpolateString(v, env);
  }
  if (Array.isArray(v)) {
    const results = v.map((item) => interpolateValue(item, env));
    return {
      value: results.map((r) => r.value),
      warnings: results.flatMap((r) => r.warnings),
    };
  }
  if (v !== null && typeof v === 'object') {
    const result: Record<string, unknown> = {};
    const warnings: string[] = [];
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      const { value: iv, warnings: iw } = interpolateValue(val, env);
      result[key] = iv;
      warnings.push(...iw);
    }
    return { value: result, warnings };
  }
  return { value: v, warnings: [] };
}
