import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeWorkerDispatchTaskReport } from './worker-dispatch-envelope-normalizer.js';
import {
  normalizeStageSummary,
  type NormalizedStageSummary,
  type NormalizedTaskReport,
  type NormalizationResult,
} from './worker-report-normalizer.js';

export interface NormalizedRunManagerArtifacts {
  stage_summary: NormalizedStageSummary;
  task_reports: NormalizedTaskReport[];
}

export interface NormalizeRunManagerArtifactsOptions {
  stageDirectory: string;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Normalize durable Manager artifacts before they cross the API-facing
 * run_manager structured-return boundary.
 *
 * Historical stage artifacts may contain compatibility shapes that are useful
 * on disk but invalid for the strict structured return schema, such as
 * tasks_completed/tasks_failed task-id arrays, successful worker reports with
 * failure_reason:null, or checklist entries using legacy aliases. This adapter
 * is the boundary seam for reading .saivage/stages/<stage>/summary.json and
 * reports/*.json: callers should validate/return only the normalized data.
 */
export function normalizeRunManagerArtifacts(
  options: NormalizeRunManagerArtifactsOptions,
): NormalizationResult<NormalizedRunManagerArtifacts> {
  const diagnostics: string[] = [];
  const summaryPath = join(options.stageDirectory, 'summary.json');
  const reportsDirectory = join(options.stageDirectory, 'reports');

  if (!existsSync(summaryPath)) {
    return { ok: false, diagnostics: [`summary.json not found at ${summaryPath}`] };
  }

  let rawSummary: unknown;
  try {
    rawSummary = readJsonFile(summaryPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, diagnostics: [`summary.json could not be read or parsed: ${message}`] };
  }

  const normalizedSummary = normalizeStageSummary(rawSummary);
  diagnostics.push(...normalizedSummary.diagnostics.map((entry) => `summary: ${entry}`));
  if (!normalizedSummary.ok || !normalizedSummary.data) {
    return { ok: false, diagnostics };
  }

  const reports: NormalizedTaskReport[] = [];
  if (existsSync(reportsDirectory)) {
    const reportFiles = readdirSync(reportsDirectory)
      .filter((entry) => entry.endsWith('.json'))
      .sort();

    for (const reportFile of reportFiles) {
      const reportPath = join(reportsDirectory, reportFile);
      let rawReport: unknown;
      try {
        rawReport = readJsonFile(reportPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push(`reports/${reportFile}: could not be read or parsed: ${message}`);
        continue;
      }

      const normalizedReport = normalizeWorkerDispatchTaskReport(rawReport, { source: `reports/${reportFile}` });
      diagnostics.push(...normalizedReport.diagnostics);
      if (!normalizedReport.ok || !normalizedReport.data) {
        diagnostics.push(`reports/${reportFile}: TaskReport could not be normalized for schema-facing return`);
        return { ok: false, diagnostics };
      }
      reports.push(normalizedReport.data);
    }
  }

  return {
    ok: true,
    data: {
      stage_summary: normalizedSummary.data,
      task_reports: reports,
    },
    diagnostics,
  };
}
