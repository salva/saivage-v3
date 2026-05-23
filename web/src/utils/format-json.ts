/**
 * Pretty-print a value as JSON with 2-space indent.
 *
 * - `undefined` returns the literal string `'undefined'` (JSON.stringify
 *   would return the `undefined` value itself, breaking string callers).
 * - `opts.redactor` is applied before stringify so secrets never reach the
 *   JSON pipeline.
 * - Circular references or other JSON.stringify errors fall back to
 *   `String(value)` — never throws.
 */
export function formatJson(
  value: unknown,
  opts?: { redactor?: (input: unknown) => unknown },
): string {
  if (value === undefined) return 'undefined';
  const safe = opts?.redactor ? opts.redactor(value) : value;
  try {
    const out = JSON.stringify(safe, null, 2);
    // JSON.stringify returns `undefined` (the value) for functions / symbols
    // at the top level. Fall back to String(value) in that case so callers
    // always receive a string.
    return out ?? String(safe);
  } catch {
    return String(safe);
  }
}
