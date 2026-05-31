export interface SanitizedClearanceForbiddenActions {
  printed_raw_bootstrap_state?: boolean;
  printed_or_persisted_secret_values?: boolean;
  ran_health_without_clearance?: boolean;
  ran_systemd_without_clearance?: boolean;
  mutated_runtime_state?: boolean;
  [key: string]: boolean | undefined;
}

export interface SanitizedClearanceReport {
  clearance_present?: boolean;
  clearance_absent?: boolean;
  action_taken?: string;
  health_checked?: boolean;
  systemd_checked?: boolean;
  state_mutated?: boolean;
  supervision_or_capability_work_dispatched?: boolean;
  forbidden_actions_performed?: SanitizedClearanceForbiddenActions;
  [key: string]: unknown;
}

export interface ClearanceReportValidationResult {
  ok: boolean;
  diagnostics: string[];
}

export interface ClearanceReportNormalizationResult extends ClearanceReportValidationResult {
  data: SanitizedClearanceReport;
}

const ABSENT_CLEARANCE_FALSE_FIELDS = [
  'health_checked',
  'systemd_checked',
  'state_mutated',
  'supervision_or_capability_work_dispatched',
] as const;

const ABSENT_CLEARANCE_FORBIDDEN_ACTION_FALSE_FIELDS = [
  'ran_health_without_clearance',
  'ran_systemd_without_clearance',
  'mutated_runtime_state',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneReport(report: SanitizedClearanceReport): SanitizedClearanceReport {
  return {
    ...report,
    forbidden_actions_performed: isRecord(report.forbidden_actions_performed)
      ? { ...report.forbidden_actions_performed }
      : report.forbidden_actions_performed,
  };
}

function hasAbsentClearance(report: SanitizedClearanceReport): boolean {
  return report.clearance_present === false || report.clearance_absent === true;
}

function absentClearanceDiagnosticSuffix(report: SanitizedClearanceReport): string {
  if (report.clearance_present === false && report.clearance_absent === true) {
    return 'clearance_present=false or clearance_absent=true';
  }
  return report.clearance_absent === true ? 'clearance_absent=true' : 'clearance_present=false';
}

function validateBooleanFalse(
  diagnostics: string[],
  value: unknown,
  path: string,
  absentSignal: string,
): void {
  if (value !== false) {
    diagnostics.push(`${path} must be false when ${absentSignal}`);
  }
}

/**
 * Validate the safety invariants for sanitized bootstrap-clearance gate reports.
 *
 * When a report says operator clearance is absent, it must also say no health,
 * systemd, supervision/capability, or runtime-state mutation action occurred.
 * This intentionally rejects omitted values as unsafe/ambiguous so stage
 * artifacts cannot invert the meaning of forbidden-action booleans. Either
 * clearance_present=false or clearance_absent=true is treated as an absent-
 * clearance signal.
 */
export function validateSanitizedClearanceReport(
  report: unknown,
): ClearanceReportValidationResult {
  const diagnostics: string[] = [];

  if (!isRecord(report)) {
    return { ok: false, diagnostics: ['report must be an object'] };
  }

  const typedReport = report as SanitizedClearanceReport;
  if (!hasAbsentClearance(typedReport)) {
    return { ok: true, diagnostics };
  }

  const absentSignal = absentClearanceDiagnosticSuffix(typedReport);
  for (const field of ABSENT_CLEARANCE_FALSE_FIELDS) {
    validateBooleanFalse(diagnostics, typedReport[field], field, absentSignal);
  }

  if (!isRecord(typedReport.forbidden_actions_performed)) {
    diagnostics.push(`forbidden_actions_performed must be an object when ${absentSignal}`);
  } else {
    for (const field of ABSENT_CLEARANCE_FORBIDDEN_ACTION_FALSE_FIELDS) {
      validateBooleanFalse(
        diagnostics,
        typedReport.forbidden_actions_performed[field],
        `forbidden_actions_performed.${String(field)}`,
        absentSignal,
      );
    }
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

/**
 * Produce a conservative, internally consistent sanitized report for the
 * no-clearance policy-halt path. The original report is not mutated.
 */
export function normalizeSanitizedClearanceReport(
  report: unknown,
): ClearanceReportNormalizationResult {
  if (!isRecord(report)) {
    return { ok: false, diagnostics: ['report must be an object'], data: {} };
  }

  const normalized = cloneReport(report as SanitizedClearanceReport);
  if (hasAbsentClearance(normalized)) {
    for (const field of ABSENT_CLEARANCE_FALSE_FIELDS) {
      normalized[field] = false;
    }

    const forbiddenActions = isRecord(normalized.forbidden_actions_performed)
      ? { ...normalized.forbidden_actions_performed }
      : {};
    for (const field of ABSENT_CLEARANCE_FORBIDDEN_ACTION_FALSE_FIELDS) {
      forbiddenActions[field] = false;
    }
    normalized.forbidden_actions_performed = forbiddenActions as SanitizedClearanceForbiddenActions;
  }

  const validation = validateSanitizedClearanceReport(normalized);
  return { ...validation, data: normalized };
}
