import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attachmentRefSchema,
  artifactRefSchema,
  cardBlocksIndexSchema,
  cardChildrenIndexSchema,
  cardDependencyIndexSchema,
  cardIndexSchema,
  cardRecordSchema,
  notesQueueSchema,
  processRecordSchema,
  projectConfigSchema,
  reviewerResultSchema,
  reviewAssessmentSchema,
  runtimeStateSchema,
  processReconciledDeadEventSchema,
  processReattachRejectedEventSchema,
} from '../src/schemas/validators.js';
import { initProjectTree } from '../src/utils/file-tree.js';
import { readRuntimeState } from '../src/utils/runtime-state.js';

describe('Derived card schemas', () => {
  it('accepts a valid card index', () => {
    const result = cardIndexSchema.safeParse({
      cards: {
        project: {
          id: 'project',
          type: 'project',
          parent: null,
          status: 'backlog',
          title: 'project',
        },
        'goal-1': {
          id: 'goal-1',
          type: 'goal',
          parent: 'project',
          status: 'active',
          title: 'Goal 1',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a card index entry whose id does not match its key', () => {
    const result = cardIndexSchema.safeParse({
      cards: {
        'goal-1': {
          id: 'goal-2',
          type: 'goal',
          parent: 'project',
          status: 'backlog',
          title: 'Mismatch',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid children index', () => {
    const result = cardChildrenIndexSchema.safeParse(['goal-1', 'goal-2']);
    expect(result.success).toBe(true);
  });

  it('rejects an invalid children index', () => {
    const result = cardChildrenIndexSchema.safeParse(['goal-1', 2]);
    expect(result.success).toBe(false);
  });

  it('accepts a valid dependency index', () => {
    const result = cardDependencyIndexSchema.safeParse({
      'goal-2': ['goal-1'],
      'code-1': ['goal-2'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid dependency index', () => {
    const result = cardDependencyIndexSchema.safeParse({
      'goal-2': ['goal-1', null],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid blocks index', () => {
    const result = cardBlocksIndexSchema.safeParse({
      'goal-1': ['goal-2'],
      'goal-2': [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid blocks index', () => {
    const result = cardBlocksIndexSchema.safeParse({
      'goal-1': 'goal-2',
    });
    expect(result.success).toBe(false);
  });
});

describe('Planner schemas', () => {
  it('exposes planner-control frame/dispatch schemas used by PlannerControlService', async () => {
    const validators = await import('../src/schemas/validators.js');
    expect('plannerFrameRecordSchema' in validators).toBe(true);
    expect('plannerDispatchRecordSchema' in validators).toBe(true);
  });
});

describe('Core schemas still validate expected records', () => {
  it('accepts a valid project config', () => {
    expect(projectConfigSchema.safeParse({
      id: 'project',
      name: 'saivage-v3',
      context: '',
      goals_summary: '',
      constraints: [],
      max_goal_depth: 5,
      planner_enabled: true,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(true);
  });

  it('accepts a valid card record', () => {
    expect(cardRecordSchema.safeParse({
      id: 'goal-1',
      type: 'goal',
      parent: 'project',
      depth: 1,
      title: 'Goal 1',
      description: '',
      status: 'backlog',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      version_seq: 1,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      metadata: { max_review_retries: 2, custom: 'kept' },
      retries: 0,
    }).success).toBe(true);
  });



  it('accepts goal-card retry override metadata and rejects invalid values', () => {
    const base = {
      id: 'goal-meta',
      type: 'goal',
      parent: 'project',
      depth: 1,
      title: 'Goal Meta',
      description: '',
      status: 'backlog',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      version_seq: 1,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
    };
    expect(cardRecordSchema.safeParse({ ...base, metadata: { max_review_retries: 4 } }).success).toBe(true);
    expect(cardRecordSchema.safeParse({ ...base, metadata: { max_review_retries: -1 } }).success).toBe(false);
  });

  it('accepts valid artifact and attachment refs', () => {
    expect(artifactRefSchema.safeParse({
      id: 'art-1',
      card_id: 'goal-1',
      path: '/tmp/a',
      type: 'report',
      description: 'desc',
      retain: true,
      created_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(true);

    expect(attachmentRefSchema.safeParse({
      id: 'att-1',
      card_id: 'goal-1',
      path: '/tmp/b',
      mime: 'text/plain',
      title: 'title',
      created_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(true);
  });

  it('accepts valid reviewer pass and needs_corrections results', () => {
    expect(reviewerResultSchema.safeParse({
      result: 'pass',
      summary: 'ok',
      achieved: ['implemented'],
      issues: [],
      evidence_card_ids: ['code-1'],
    }).success).toBe(true);

    expect(reviewerResultSchema.safeParse({
      result: 'needs_corrections',
      summary: 'fix required',
      achieved: [],
      issues: [{ summary: 'missing test', severity: 'blocker', evidence_card_id: 'test-1', recommendation: 'add coverage' }],
      evidence_card_ids: [],
    }).success).toBe(true);
  });

  it('rejects legacy reviewer result fail/missing payloads at the schema boundary', () => {
    expect(reviewerResultSchema.safeParse({
      result: 'fail',
      summary: 'old failure shape',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
    }).success).toBe(false);

    expect(reviewerResultSchema.safeParse({
      result: 'needs_corrections',
      summary: 'old missing shape',
      achieved: [],
      missing: ['legacy missing entry'],
      evidence_card_ids: [],
    }).success).toBe(false);
  });

  it('accepts a valid review assessment with required preallocated metadata', () => {
    expect(reviewAssessmentSchema.safeParse({
      assessment_id: 'assessment-1',
      at: '2025-01-01T00:00:00.000Z',
      goal_card_id: 'goal-1',
      reviewer_session_id: 'reviewer:goal-1:assessment-1',
      result: 'pass',
      summary: 'ok',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
    }).success).toBe(true);
  });

  it('rejects legacy review assessments without required metadata or with missing[]', () => {
    expect(reviewAssessmentSchema.safeParse({
      id: 'review-1',
      goal_card_id: 'goal-1',
      reviewer_session_id: 'reviewer-1',
      result: 'pass',
      summary: 'ok',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
      created_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(false);

    expect(reviewAssessmentSchema.safeParse({
      assessment_id: 'assessment-2',
      at: '2025-01-01T00:00:00.000Z',
      result: 'needs_corrections',
      summary: 'legacy missing shape',
      achieved: [],
      issues: [],
      missing: ['legacy missing entry'],
      evidence_card_ids: [],
    }).success).toBe(false);
  });

  it('accepts a valid process record', () => {
    expect(processRecordSchema.safeParse({
      id: 'proc-1',
      card_id: 'goal-1',
      command: 'npm test',
      command_hash: 'a'.repeat(64),
      cwd: '/tmp',
      cwd_canonical: '/tmp',
      status: 'running',
      started_at: '2025-01-01T00:00:00.000Z',
      started_at_monotonic: 1,
      required_for_card_completion: false,
      output_dir: '/tmp/out',
      stdout_path: '/tmp/out/stdout.log',
      stderr_path: '/tmp/out/stderr.log',
      combined_log_path: '/tmp/out/combined.log',
    }).success).toBe(true);
  });


  it('accepts typed process reconciliation audit events and rejects raw command fields', () => {
    expect(processReconciledDeadEventSchema.safeParse({
      id: 'evt-1',
      kind: 'process_reconciled_dead',
      timestamp: '2025-01-01T00:00:00.000Z',
      process_id: 'proc-1',
      card_id: 'card-1',
      goal_id: 'goal-1',
      session_id: 'sess-1',
      pid: 123,
      probe_status: 'not_running',
      terminal_reason: 'lost',
      failure_classification: 'lost',
      detail: 'restart identity probe mismatch',
    }).success).toBe(true);
    expect(processReattachRejectedEventSchema.safeParse({
      id: 'evt-2',
      kind: 'process_reattach_rejected',
      timestamp: '2025-01-01T00:00:00.000Z',
      process_id: 'proc-2',
      card_id: 'card-2',
      terminal_reason: 'lost',
      failure_classification: 'lost',
      reattach_error: 'process reattach failed',
      detail: 'process reattach failed',
      command: 'echo sk-live-secret',
    }).success).toBe(false);
  });

  it('accepts a valid runtime state', () => {
    expect(runtimeStateSchema.safeParse({
      status: 'running',
      project_id: 'project',
      pid: 123,
      started_at: '2025-01-01T00:00:00.000Z',
      paused: false,
      queue: [],
      running_processes: [],
      updated_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(true);
  });

  it('accepts the hardened notes queue shape', () => {
    expect(notesQueueSchema.safeParse({
      next_note_sequence: 1,
      entries: [],
    }).success).toBe(true);
  });

  it('rejects legacy runtime state with discard guidance', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-legacy-'));
    try {
      initProjectTree(root);
      writeFileSync(
        join(root, '.saivage', 'runtime', 'state.json'),
        JSON.stringify({ status: 'idle', queue: [] }, null, 2),
      );
      expect(() => readRuntimeState(root)).toThrow(/discarded-<timestamp>|Legacy \.saivage state is not supported/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects legacy card record shape via schema parse', () => {
    const result = cardRecordSchema.safeParse({
      id: 'goal-1',
      type: 'goal',
      parent: 'project',
      depth: 1,
      title: 'Goal 1',
      description: '',
      status: 'backlog',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      metadata: { max_review_retries: 2, custom: 'kept' },
      retries: 0,
    });
    expect(result.success).toBe(false);
  });
});
