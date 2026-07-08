const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface EnvInterpolationResult {
  value: string;
  warnings: string[];
}

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export interface InterpolateOptions {
  readonly skipRootKeys?: ReadonlySet<string>;
}

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

/** Deep-interpolate ${ENV_VAR} references in any config-compatible value. */
export function interpolateValue(v: unknown, env: EnvironmentSource, options?: InterpolateOptions): { value: unknown; warnings: string[] } {
  return interpolateValueImpl(v, env, options, true);
}

function interpolateValueImpl(v: unknown, env: EnvironmentSource, options: InterpolateOptions | undefined, isRoot: boolean): { value: unknown; warnings: string[] } {
  if (typeof v === 'string') {
    return interpolateString(v, env);
  }
  if (Array.isArray(v)) {
    const results = v.map((item) => interpolateValueImpl(item, env, options, false));
    return {
      value: results.map((r) => r.value),
      warnings: results.flatMap((r) => r.warnings),
    };
  }
  if (v !== null && typeof v === 'object') {
    const result: Record<string, unknown> = {};
    const warnings: string[] = [];
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      if (isRoot && options?.skipRootKeys?.has(key)) {
        result[key] = val;
        continue;
      }
      const { value: iv, warnings: iw } = interpolateValueImpl(val, env, options, false);
      result[key] = iv;
      warnings.push(...iw);
    }
    return { value: result, warnings };
  }
  return { value: v, warnings: [] };
}
