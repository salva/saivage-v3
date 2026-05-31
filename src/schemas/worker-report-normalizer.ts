export type WorkerReportStatus = 'completed' | 'failed';
export type StageSummaryResult = 'completed' | 'failed' | 'escalated';

export interface WorkerChecklistResult {
  description: string;
  required: boolean;
  passed: boolean;
  note?: string;
  evidence?: unknown;
}

export interface WorkerIssue {
  severity: 'error' | 'warning' | 'info' | string;
  description: string;
  file?: string;
  line?: number;
  error_output?: string;
  root_cause?: string;
  suggestion?: string;
  [key: string]: unknown;
}

export interface NormalizedTaskReport {
  task_id: string;
  stage_id: string;
  status: WorkerReportStatus;
  checklist_results: WorkerChecklistResult[];
  issues_found: WorkerIssue[];
  summary: string;
  failure_reason?: string;
  acceptance_criteria_results?: unknown[];
  compatibility_notes?: string[];
  [key: string]: unknown;
}

export interface NormalizedStageSummary {
  stage_id: string;
  result: StageSummaryResult;
  summary: string;
  tasks_completed: number;
  tasks_failed: number;
  total_tasks: number;
  completed_task_ids?: string[];
  failed_task_ids?: string[];
  outcomes_achieved: string[];
  outcomes_missed: string[];
  issues: WorkerIssue[];
  acceptance_criteria_results?: unknown[];
  compatibility_notes?: string[];
  [key: string]: unknown;
}

export interface NormalizationResult<T> {
  ok: boolean;
  data?: T;
  diagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeStatus(value: unknown, diagnostics: string[]): WorkerReportStatus | null {
  if (value === 'completed' || value === 'success' || value === 'succeeded' || value === 'passed' || value === 'pass') {
    if (value !== 'completed') diagnostics.push(`status '${String(value)}' normalized to 'completed'`);
    return 'completed';
  }
  if (value === 'failed' || value === 'failure' || value === 'error') {
    if (value !== 'failed') diagnostics.push(`status '${String(value)}' normalized to 'failed'`);
    return 'failed';
  }
  diagnostics.push(`status must be completed/failed or a known compatibility value; received ${JSON.stringify(value)}`);
  return null;
}

function normalizeChecklistEntry(value: unknown, index: number, diagnostics: string[]): WorkerChecklistResult | null {
  if (!isRecord(value)) {
    diagnostics.push(`checklist_results[${index}] must be an object`);
    return null;
  }

  const rawDescription = value.description ?? value.item ?? value.criterion;
  const description = stringValue(rawDescription);
  if (!description) {
    diagnostics.push(`checklist_results[${index}].description is required; legacy item/criterion aliases were also absent`);
    return null;
  }
  if (value.description === undefined && value.item !== undefined) {
    diagnostics.push(`checklist_results[${index}].item normalized to description`);
  }

  let passed: boolean;
  if (typeof value.passed === 'boolean') {
    passed = value.passed;
  } else if (value.status === 'passed' || value.status === 'pass' || value.status === 'completed' || value.status === 'success') {
    diagnostics.push(`checklist_results[${index}].status '${String(value.status)}' normalized to passed=true`);
    passed = true;
  } else if (value.status === 'failed' || value.status === 'fail' || value.status === 'error') {
    diagnostics.push(`checklist_results[${index}].status '${String(value.status)}' normalized to passed=false`);
    passed = false;
  } else {
    diagnostics.push(`checklist_results[${index}].passed is required; no known status alias was present`);
    return null;
  }

  const required = typeof value.required === 'boolean' ? value.required : true;
  if (value.required === undefined) diagnostics.push(`checklist_results[${index}].required defaulted to true`);

  const normalized: WorkerChecklistResult = { description, required, passed };
  if (typeof value.note === 'string') normalized.note = value.note;
  if (typeof value.notes === 'string' && normalized.note === undefined) normalized.note = value.notes;
  if (value.evidence !== undefined) normalized.evidence = value.evidence;
  return normalized;
}

function normalizeIssues(value: unknown, diagnostics: string[], fieldName: string): WorkerIssue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(`${fieldName} must be an array; non-array value ignored`);
    return [];
  }
  return value.flatMap((entry, index): WorkerIssue[] => {
    if (!isRecord(entry)) {
      diagnostics.push(`${fieldName}[${index}] must be an object; entry ignored`);
      return [];
    }
    const description = stringValue(entry.description ?? entry.summary, 'Unspecified issue');
    const issue: WorkerIssue = {
      ...entry,
      severity: stringValue(entry.severity, 'warning'),
      description,
    };
    if (entry.line === null) {
      diagnostics.push(`${fieldName}[${index}].line null removed`);
      delete issue.line;
    } else if (typeof entry.line === 'number') {
      issue.line = entry.line;
    } else if (entry.line !== undefined) {
      diagnostics.push(`${fieldName}[${index}].line must be numeric when present; value removed`);
      delete issue.line;
    }
    return [issue];
  });
}

export function normalizeTaskReport(input: unknown): NormalizationResult<NormalizedTaskReport> {
  const diagnostics: string[] = [];
  if (!isRecord(input)) return { ok: false, diagnostics: ['TaskReport must be an object'] };

  const status = normalizeStatus(input.status, diagnostics);
  const checklist = Array.isArray(input.checklist_results)
    ? input.checklist_results.map((entry, index) => normalizeChecklistEntry(entry, index, diagnostics))
    : null;
  if (!Array.isArray(input.checklist_results)) diagnostics.push('checklist_results must be an array');

  const taskId = stringValue(input.task_id);
  const stageId = stringValue(input.stage_id);
  const summary = stringValue(input.summary);
  if (!taskId) diagnostics.push('task_id is required');
  if (!stageId) diagnostics.push('stage_id is required');
  if (!summary) diagnostics.push('summary is required');

  const normalizedChecklist = checklist?.filter((entry): entry is WorkerChecklistResult => entry !== null) ?? [];
  const hasInvalidChecklist = checklist?.some((entry) => entry === null) ?? true;
  const hasRequiredError = !status || !taskId || !stageId || !summary || hasInvalidChecklist;
  if (hasRequiredError) return { ok: false, diagnostics };

  const report: NormalizedTaskReport = {
    ...input,
    task_id: taskId,
    stage_id: stageId,
    status,
    checklist_results: normalizedChecklist,
    issues_found: normalizeIssues(input.issues_found, diagnostics, 'issues_found'),
    summary,
  };

  if (input.failure_reason === null || input.failure_reason === undefined) {
    if (status === 'failed') {
      report.failure_reason = '';
      diagnostics.push('failure_reason missing/null on failed report normalized to empty string');
    } else {
      delete report.failure_reason;
      if (input.failure_reason === null) diagnostics.push('failure_reason null removed from successful report');
    }
  } else if (typeof input.failure_reason === 'string') {
    report.failure_reason = input.failure_reason;
  } else {
    report.failure_reason = String(input.failure_reason);
    diagnostics.push('failure_reason normalized to string');
  }

  if (Array.isArray(input.acceptance_criteria_results)) report.acceptance_criteria_results = input.acceptance_criteria_results;
  if (diagnostics.length > 0) report.compatibility_notes = diagnostics;
  return { ok: true, data: report, diagnostics };
}

function normalizeStageResult(value: unknown, diagnostics: string[]): StageSummaryResult | null {
  if (value === 'completed' || value === 'failed' || value === 'escalated') return value;
  if (value === 'passed' || value === 'pass' || value === 'success' || value === 'succeeded') {
    diagnostics.push(`result '${String(value)}' normalized to 'completed'`);
    return 'completed';
  }
  diagnostics.push(`result must be completed/failed/escalated or a known compatibility value; received ${JSON.stringify(value)}`);
  return null;
}

function normalizeTaskCount(value: unknown, fieldName: string, diagnostics: string[]): { count: number; ids?: string[] } | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return { count: value };
  if (Array.isArray(value)) {
    const ids = value.map(String);
    diagnostics.push(`${fieldName} array normalized to count ${ids.length}`);
    return { count: ids.length, ids };
  }
  diagnostics.push(`${fieldName} must be a non-negative integer or legacy task id array`);
  return null;
}

export function normalizeStageSummary(input: unknown): NormalizationResult<NormalizedStageSummary> {
  const diagnostics: string[] = [];
  if (!isRecord(input)) return { ok: false, diagnostics: ['StageSummary must be an object'] };

  const result = normalizeStageResult(input.result, diagnostics);
  const completed = normalizeTaskCount(input.tasks_completed, 'tasks_completed', diagnostics);
  const failed = normalizeTaskCount(input.tasks_failed, 'tasks_failed', diagnostics);
  const stageId = stringValue(input.stage_id);
  const summary = stringValue(input.summary);
  if (!stageId) diagnostics.push('stage_id is required');
  if (!summary) diagnostics.push('summary is required');
  if (!result || !completed || !failed || !stageId || !summary) return { ok: false, diagnostics };

  const totalTasks = typeof input.total_tasks === 'number' && Number.isInteger(input.total_tasks) && input.total_tasks >= 0
    ? input.total_tasks
    : completed.count + failed.count;
  if (input.total_tasks === undefined) diagnostics.push('total_tasks defaulted from completed+failed counts');

  const summaryResult: NormalizedStageSummary = {
    ...input,
    stage_id: stageId,
    result,
    summary,
    tasks_completed: completed.count,
    tasks_failed: failed.count,
    total_tasks: totalTasks,
    outcomes_achieved: stringArray(input.outcomes_achieved),
    outcomes_missed: stringArray(input.outcomes_missed),
    issues: normalizeIssues(input.issues, diagnostics, 'issues'),
  };

  if (completed.ids) summaryResult.completed_task_ids = completed.ids;
  if (failed.ids) summaryResult.failed_task_ids = failed.ids;
  if (Array.isArray(input.acceptance_criteria_results)) summaryResult.acceptance_criteria_results = input.acceptance_criteria_results;
  if (diagnostics.length > 0) summaryResult.compatibility_notes = diagnostics;
  return { ok: true, data: summaryResult, diagnostics };
}
