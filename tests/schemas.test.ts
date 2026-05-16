import { describe, it, expect } from '@jest/globals';
import {
  attachmentRefSchema,
  artifactRefSchema,
  cardBlocksIndexSchema,
  cardChildrenIndexSchema,
  cardDependencyIndexSchema,
  cardIndexSchema,
  cardRecordSchema,
  notesQueueSchema,
  plannerDispatchRecordSchema,
  plannerFrameRecordSchema,
  processRecordSchema,
  projectConfigSchema,
  reviewAssessmentSchema,
  runtimeStateSchema,
} from '../src/schemas/validators.js';

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
  const review = {
    id: 'review-1',
    goal_card_id: 'goal-1',
    reviewer_session_id: 'reviewer-1',
    result: 'pass',
    summary: 'ok',
    achieved: [],
    missing: [],
    evidence_card_ids: ['code-1'],
    created_at: '2025-01-01T00:00:00.000Z',
  } as const;

  const artifact = {
    id: 'art-1',
    card_id: 'code-1',
    path: '.saivage-work/cards/code-1/artifacts/out.txt',
    type: 'report',
    description: 'out',
    retain: true,
    created_at: '2025-01-01T00:00:00.000Z',
  } as const;

  const attachment = {
    id: 'att-1',
    card_id: 'code-1',
    path: '.saivage-work/cards/code-1/attachments/in.txt',
    mime: 'text/plain',
    title: 'input',
    created_at: '2025-01-01T00:00:00.000Z',
  } as const;

  it('accepts queued planner frame status', () => {
    const result = plannerFrameRecordSchema.safeParse({
      frame_id: 'frm-goal-1-1',
      planner_card_id: 'goal-1',
      planner_role: 'planner',
      planner_scope: 'goal',
      status: 'queued',
      resume_reason: 'none',
      waiting_on_dispatch_ids: [],
      last_resume_cursor: null,
      last_dispatch_id: null,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts completed dispatch with durable completion evidence', () => {
    const result = plannerDispatchRecordSchema.safeParse({
      dispatch_id: 'dsp-code-1-1',
      parent_frame_id: 'frm-goal-1-1',
      parent_card_id: 'goal-1',
      target_card_id: 'code-1',
      target_kind: 'terminal_card',
      requested_by_role: 'planner',
      requested_by_scope: 'goal',
      status: 'completed',
      completion: {
        outcome: 'done',
        summary: 'done',
        child_result: { ok: true },
        review,
        artifacts: [artifact],
        attachments: [attachment],
        evidence_card_ids: ['code-1'],
        error: null,
      },
      idempotency_key: 'goal-1:code-1',
      created_at: '2025-01-01T00:00:00.000Z',
      started_at: '2025-01-01T00:00:01.000Z',
      completed_at: '2025-01-01T00:00:02.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('currently accepts terminal dispatch without completion evidence', () => {
    const result = plannerDispatchRecordSchema.safeParse({
      dispatch_id: 'dsp-code-1-1',
      parent_frame_id: 'frm-goal-1-1',
      parent_card_id: 'goal-1',
      target_card_id: 'code-1',
      target_kind: 'terminal_card',
      requested_by_role: 'planner',
      requested_by_scope: 'goal',
      status: 'completed',
      completion: null,
      idempotency_key: 'goal-1:code-1',
      created_at: '2025-01-01T00:00:00.000Z',
      started_at: '2025-01-01T00:00:01.000Z',
      completed_at: '2025-01-01T00:00:02.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('currently accepts completion outcome mismatched to dispatch status', () => {
    const result = plannerDispatchRecordSchema.safeParse({
      dispatch_id: 'dsp-code-1-1',
      parent_frame_id: 'frm-goal-1-1',
      parent_card_id: 'goal-1',
      target_card_id: 'code-1',
      target_kind: 'terminal_card',
      requested_by_role: 'planner',
      requested_by_scope: 'goal',
      status: 'failed',
      completion: {
        outcome: 'done',
        summary: 'wrong',
        child_result: null,
        review: null,
        artifacts: [],
        attachments: [],
        evidence_card_ids: [],
        error: 'bad',
      },
      idempotency_key: 'goal-1:code-1',
      created_at: '2025-01-01T00:00:00.000Z',
      started_at: '2025-01-01T00:00:01.000Z',
      completed_at: '2025-01-01T00:00:02.000Z',
    });
    expect(result.success).toBe(true);
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
      retries: 0,
    }).success).toBe(true);
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

  it('accepts a valid review assessment', () => {
    expect(reviewAssessmentSchema.safeParse({
      id: 'review-1',
      goal_card_id: 'goal-1',
      reviewer_session_id: 'reviewer-1',
      result: 'pass',
      summary: 'ok',
      achieved: [],
      missing: [],
      evidence_card_ids: [],
      created_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(true);
  });

  it('accepts a valid process record', () => {
    expect(processRecordSchema.safeParse({
      id: 'proc-1',
      card_id: 'goal-1',
      command: 'npm test',
      cwd: '/tmp',
      status: 'running',
      started_at: '2025-01-01T00:00:00.000Z',
      required_for_card_completion: false,
      output_dir: '/tmp/out',
      stdout_path: '/tmp/out/stdout.log',
      stderr_path: '/tmp/out/stderr.log',
      combined_log_path: '/tmp/out/combined.log',
    }).success).toBe(true);
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
});
