import { describe, expect, it } from '@jest/globals';
import { buildProjectRunCompletedPayload } from '../../src/runtime/runtime-reviewer-dispatcher.js';
import type { CardRecord, ReviewAssessment } from '../../src/schemas/types.js';

function card(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'project',
    type: 'project',
    parent: null,
    depth: 0,
    title: 'Project',
    description: '',
    status: 'done',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'operator',
    depends_on: [],
    related: [],
    blocks: [],
    artifacts: [],
    attachments: [],
    acceptance: '',
    retries: 0,
    ...overrides,
  } as CardRecord;
}

describe('project run completion helper', () => {
  it('builds done payloads with review summary preference', () => {
    const assessment = { summary: 'review passed' } as ReviewAssessment;
    expect(buildProjectRunCompletedPayload(card({ status_text: 'status text' }), assessment)).toEqual({ project_card_id: 'project', result: 'done', summary: 'review passed' });
  });

  it('builds blocked and failed payload details', () => {
    expect(buildProjectRunCompletedPayload(card({ status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'needs operator', resume_reason: 'planner_blocked' }, error: 'needs operator', completed_at: null } }))).toEqual({ project_card_id: 'project', result: 'blocked', summary: 'needs operator', blocked_reason: 'needs operator' });
    expect(buildProjectRunCompletedPayload(card({ status: 'failed', lifecycle: { status: 'failed', result: { kind: 'executor_failure', error: 'planner_error', partial_result: null, latest_self_report: { result: 'failed', outcome: 'failed', summary: 'planner_error', status_text: 'failed', at: '2026-01-01T00:00:00.000Z' } }, error: 'planner_error', completed_at: '2026-01-01T00:00:00.000Z' } }))).toEqual({ project_card_id: 'project', result: 'failed', summary: 'planner_error', failure_kind: 'planner_error' });
  });
});
