import {
  normalizeTaskReport,
  type NormalizedTaskReport,
  type NormalizationResult,
} from './worker-report-normalizer.js';

export interface NormalizeWorkerDispatchTaskReportOptions {
  source?: string;
}

/**
 * Normalize a worker TaskReport at the dispatch structured-return boundary.
 *
 * Durable worker artifacts may preserve historical compatibility values such as
 * failure_reason:null on successful Coder/Reviewer reports. The strict
 * schema-facing worker dispatch envelope must not validate or return those raw
 * values; it should expose only normalizeTaskReport output.
 */
export function normalizeWorkerDispatchTaskReport(
  report: unknown,
  options: NormalizeWorkerDispatchTaskReportOptions = {},
): NormalizationResult<NormalizedTaskReport> {
  const normalized = normalizeTaskReport(report);
  if (!options.source) return normalized;

  return {
    ...normalized,
    diagnostics: normalized.diagnostics.map((entry) => `${options.source}: ${entry}`),
  };
}
