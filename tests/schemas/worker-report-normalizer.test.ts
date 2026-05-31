import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeStageSummary, normalizeTaskReport } from '../../src/schemas/worker-report-normalizer.js';

const repairStageRoot = join(process.cwd(), '.saivage', 'stages', 'repair-deployed-prompts-and-smoketest');

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(repairStageRoot, relativePath), 'utf8'));
}

describe('worker report compatibility normalization', () => {
  it('normalizes repair-stage StageSummary task id arrays into numeric task counts and preserves ids', () => {
    const normalized = normalizeStageSummary(readJson('summary.json'));

    expect(normalized.ok).toBe(true);
    expect(normalized.data).toEqual(expect.objectContaining({
      stage_id: 'repair-deployed-prompts-and-smoketest',
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
    const normalized = normalizeTaskReport(readJson('reports/t1-fix-prompt-asset-deploy.json'));

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.data?.failure_reason).toBeUndefined();
    expect(normalized.data?.checklist_results).toHaveLength(6);
    expect(normalized.data?.checklist_results[0]).toEqual(expect.objectContaining({
      description: 'Inspect prompt loading/build/deploy layout and implement deterministic prompt asset packaging.',
      required: true,
      passed: true,
    }));
    expect(normalized.data?.checklist_results[0]).not.toHaveProperty('item');
    expect(normalized.diagnostics).toContain('checklist_results[0].item normalized to description');
    expect(normalized.diagnostics).toContain('failure_reason null removed from successful report');
  });

  it('normalizes reviewer status passed deterministically to completed and preserves evidence', () => {
    const normalized = normalizeTaskReport(readJson('reports/t2-stage-review.json'));

    expect(normalized.ok).toBe(true);
    expect(normalized.data?.status).toBe('completed');
    expect(normalized.data?.checklist_results[0]).toEqual(expect.objectContaining({
      description: 'Prompt asset packaging fix is source-controlled and deterministic, not ad-hoc only',
      required: true,
      passed: true,
      evidence: [
        't1-fix-prompt-asset-deploy',
        'scripts/copy-prompt-assets.js',
        'package.json',
        'src/prompts/reviewer.md',
        'src/prompts/planner.md',
        'src/prompts/executor.md',
      ],
    }));
    expect(normalized.diagnostics).toContain("status 'passed' normalized to 'completed'");
    expect(normalized.diagnostics).toContain('checklist_results[0].item normalized to description');
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
