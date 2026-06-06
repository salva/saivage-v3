import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { normalizeWorkerDispatchTaskReport } from '../../src/schemas/worker-dispatch-envelope-normalizer.js';
import { normalizeStageSummary, normalizeTaskReport } from '../../src/schemas/worker-report-normalizer.js';

const fixtureRoot = join(process.cwd(), 'tests', 'fixtures', 'worker-report-normalizer');
const promptRepairFixtureId = 'fixture-prompt-repair';
const clearanceGateFixtureId = 'fixture-clearance-gate';
const reviewerAliasFixtureId = 'fixture-reviewer-alias';

function readFixtureJson(fixtureId: string, relativePath: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, fixtureId, relativePath), 'utf8'));
}


const strictTaskReportSchema = z.object({
  task_id: z.string(),
  stage_id: z.string(),
  status: z.enum(['completed', 'failed']),
  checklist_results: z.array(z.object({
    description: z.string(),
    required: z.boolean(),
    passed: z.boolean(),
    note: z.string().optional(),
    evidence: z.unknown().optional(),
  }).strict()),
  issues_found: z.array(z.record(z.string(), z.unknown())),
  summary: z.string(),
  failure_reason: z.string().optional(),
}).passthrough();

describe('worker report compatibility normalization', () => {
  it('normalizes synthetic StageSummary task id arrays into numeric task counts and preserves ids', () => {
    const normalized = normalizeStageSummary(readFixtureJson(promptRepairFixtureId, 'summary.json'));

    expect(normalized.ok).toBe(true);
    expect(normalized.data).toEqual(expect.objectContaining({
      stage_id: promptRepairFixtureId,
      result: 'completed',
      tasks_completed: 2,
      tasks_failed: 0,
      total_tasks: 2,
      completed_task_ids: ['t1-fix-prompt-asset-deploy', 't2-stage-review'],
      failed_task_ids: [],
    }));
    expect(normalized.diagnostics).toContain('tasks_completed array normalized to count 2');
    expect(normalized.diagnostics).toContain('tasks_failed array normalized to count 0');
  });

  it('normalizes coder checklist item aliases and removes null failure_reason on successful reports', () => {
    const normalized = normalizeTaskReport(readFixtureJson(promptRepairFixtureId, 'reports/t1-fix-prompt-asset-deploy.json'));

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.data?.failure_reason).toBeUndefined();
    expect(normalized.data?.checklist_results).toHaveLength(6);
    expect(normalized.data?.checklist_results[0]).toEqual(expect.objectContaining({
      description: 'Inspect prompt packaging and implement deterministic asset copy behavior.',
      required: true,
      passed: true,
    }));
    expect(normalized.data?.checklist_results[0]).not.toHaveProperty('item');
    expect(normalized.diagnostics).toContain('checklist_results[0].item normalized to description');
    expect(normalized.diagnostics).toContain('failure_reason null removed from successful report');
  });

  it('normalizes reviewer status pass deterministically to completed for schema-facing validation', () => {
    const normalized = normalizeTaskReport({
      task_id: 't2-stage-review',
      stage_id: reviewerAliasFixtureId,
      status: 'pass',
      checklist_results: [
        {
          description: 'Reviewer confirms status alias pass is accepted as successful.',
          required: true,
          passed: true,
        },
      ],
      issues_found: [],
      summary: 'Reviewer passed the stage using the pass alias.',
    });

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.diagnostics).toContain("status 'pass' normalized to 'completed'");
  });

  it('normalizes reviewer status passed deterministically to completed for schema-facing validation', () => {
    const normalized = normalizeTaskReport({
      task_id: 't2-stage-review',
      stage_id: reviewerAliasFixtureId,
      status: 'passed',
      checklist_results: [
        {
          description: 'Reviewer confirms status alias passed is accepted as successful.',
          required: true,
          passed: true,
        },
      ],
      issues_found: [],
      summary: 'Reviewer passed the stage using the passed alias.',
    });

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.diagnostics).toContain("status 'passed' normalized to 'completed'");
  });

  it('normalizes reviewer status passed deterministically to completed and preserves evidence', () => {
    const normalized = normalizeTaskReport(readFixtureJson(promptRepairFixtureId, 'reports/t2-stage-review.json'));

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.data?.checklist_results[0]).toEqual(expect.objectContaining({
      description: 'Prompt asset packaging is deterministic and source-controlled.',
      required: true,
      passed: true,
      evidence: [
        't1-fix-prompt-asset-deploy',
        'scripts/copy-prompt-assets.js',
        'package.json',
        'src/prompts/example-reviewer.md',
        'src/prompts/example-planner.md',
        'src/prompts/example-executor.md',
      ],
    }));
    expect(normalized.diagnostics).toContain("status 'passed' normalized to 'completed'");
    expect(normalized.diagnostics).toContain('checklist_results[0].item normalized to description');
  });

  it('normalizes synthetic Coder report item-only checklist entries for schema-facing serialization', () => {
    const normalized = normalizeTaskReport(readFixtureJson(clearanceGateFixtureId, 'reports/t1-sanitized-clearance-gate.json'));

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.task_id).toBe('t1-sanitized-clearance-gate');
    expect(normalized.data?.stage_id).toBe(clearanceGateFixtureId);
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.data?.failure_reason).toBeUndefined();
    expect(normalized.data?.checklist_results).toHaveLength(4);
    expect(normalized.data?.checklist_results[0]).toEqual({
      description: 'Inspect only sanitized state metadata for explicit operator clearance',
      required: true,
      passed: true,
      note: 'Fixture reports only non-secret metadata and clearance-indicator key presence.',
    });
    expect(normalized.data?.checklist_results.every((entry) => typeof entry.description === 'string' && entry.description.length > 0)).toBe(true);

    const schemaFacingJson = JSON.stringify(normalized.data);
    expect(schemaFacingJson).not.toContain('"item"');
    expect(schemaFacingJson).not.toContain('"failure_reason":null');
    expect(normalized.diagnostics).toEqual(expect.arrayContaining([
      'checklist_results[0].item normalized to description',
      'checklist_results[1].item normalized to description',
      'checklist_results[2].item normalized to description',
      'checklist_results[3].item normalized to description',
      'failure_reason null removed from successful report',
    ]));
  });

  it('normalizes synthetic Reviewer report item-only checklist and null failure_reason for schema-facing serialization', () => {
    const normalized = normalizeTaskReport(readFixtureJson(clearanceGateFixtureId, 'reports/t2-stage-review.json'));

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.task_id).toBe('t2-stage-review');
    expect(normalized.data?.stage_id).toBe(clearanceGateFixtureId);
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.data?.failure_reason).toBeUndefined();
    expect(normalized.data?.checklist_results).toEqual([
      {
        description: 'Reviewer confirms no unauthorized state advancement or secret exposure occurred.',
        required: true,
        passed: true,
        note: 'Synthetic reports record a policy halt with sanitized metadata only and no clearance indicators.',
      },
    ]);

    const schemaFacingJson = JSON.stringify(normalized.data);
    expect(schemaFacingJson).not.toContain('"item"');
    expect(schemaFacingJson).not.toContain('"failure_reason":null');
    expect(normalized.diagnostics).toEqual(expect.arrayContaining([
      'checklist_results[0].item normalized to description',
      'failure_reason null removed from successful report',
    ]));
  });

  it('normalizes a synthetic Coder dispatch return report before strict schema validation', () => {
    const normalized = normalizeWorkerDispatchTaskReport(
      readFixtureJson(reviewerAliasFixtureId, 'reports/t1-reviewer-status-alias-tests.json'),
      { source: 'reports/t1-reviewer-status-alias-tests.json' },
    );

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.task_id).toBe('t1-reviewer-status-alias-tests');
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.data?.failure_reason).toBeUndefined();
    expect(JSON.stringify(normalized.data)).not.toContain('"failure_reason":null');
    expect(normalized.diagnostics).toContain(
      'reports/t1-reviewer-status-alias-tests.json: failure_reason null removed from successful report',
    );
  });

  it('normalizes a synthetic Reviewer dispatch return report before strict schema validation', () => {
    const normalized = normalizeWorkerDispatchTaskReport(
      readFixtureJson(reviewerAliasFixtureId, 'reports/t2-stage-review.json'),
      { source: 'reports/t2-stage-review.json' },
    );

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.task_id).toBe('t2-stage-review');
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.data?.failure_reason).toBeUndefined();
    expect(JSON.stringify(normalized.data)).not.toContain('"failure_reason":null');
    expect(normalized.diagnostics).toContain(
      'reports/t2-stage-review.json: failure_reason null removed from successful report',
    );
  });

  it('normalizes a successful Reviewer dispatch object before strict schema validation rejects failure_reason:null', () => {
    const rawReport = readFixtureJson(reviewerAliasFixtureId, 'reports/t2-stage-review.json');

    expect(strictTaskReportSchema.safeParse(rawReport).success).toBe(false);

    const normalized = normalizeWorkerDispatchTaskReport(rawReport, { source: 'reports/t2-stage-review.json' });

    expect(normalized.ok).toBe(true);
    expect(normalized.data).toBeDefined();
    expect(strictTaskReportSchema.safeParse(normalized.data).success).toBe(true);
    expect(normalized.data).not.toHaveProperty('failure_reason');
    expect(JSON.stringify(normalized.data)).not.toContain('"failure_reason":null');
  });

  it('reports clear diagnostics for unrepairable worker report shapes', () => {
    const normalized = normalizeTaskReport({
      task_id: 'bad-task',
      stage_id: 'stage',
      status: 'mystery',
      summary: 'bad',
      checklist_results: [{ item: 'missing pass state' }],
    });

    expect(normalized.ok).toBe(false);
    expect(normalized.diagnostics).toEqual(expect.arrayContaining([
      'status must be completed/failed or a known compatibility value; received "mystery"',
      'checklist_results[0].passed is required; no known status alias was present',
    ]));
  });
});
