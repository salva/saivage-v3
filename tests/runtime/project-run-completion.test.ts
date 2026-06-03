import { describe, expect, it } from '@jest/globals';
import { buildProjectRunCompletedPayload } from '../../src/runtime/project-run-completion.js';
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
    expect(buildProjectRunCompletedPayload(card({ status: 'blocked', error: 'needs operator' }))).toEqual({ project_card_id: 'project', result: 'blocked', summary: 'needs operator', blocked_reason: 'needs operator' });
    expect(buildProjectRunCompletedPayload(card({ status: 'failed', error: 'planner_error' }))).toEqual({ project_card_id: 'project', result: 'failed', summary: 'planner_error', failure_kind: 'planner_error' });
  });
});
