import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { evaluateReviewerTerminalOutcome } from '../../../src/runtime/actors/reviewer-terminal-evaluation.js';
import type { LLMActorOutcome } from '../../../src/runtime/actors/index.js';
import type { CardRecord, PlannerDoneResult } from '../../../src/schemas/index.js';

function withTempProject<T>(fn: (projectRoot: string) => T): T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-reviewer-terminal-'));
  try {
    return fn(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function createProject(store: CardStore): CardRecord {
  return store.create({ type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], acceptance: '', retries: 0 });
}

function createDoneChild(store: CardStore, parent: string): CardRecord {
  const child = store.create({ type: 'goal', parent, depth: 1, title: 'child', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], acceptance: '', retries: 0 });
  return store.commitTerminalLifecyclePatch(child.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'planner_done', summary: 'child done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
}

function reviewerOutcome(overrides: Record<string, unknown> = {}): Extract<LLMActorOutcome, { type: 'tool_call' }> {
  return {
    type: 'tool_call',
    agentId: 'reviewer:card-1',
    inputId: 'reviewer:card-1:1',
    toolCallId: 'reviewer-result-1',
    toolName: 'emit_reviewer_result',
    args: { assessment: { result: 'pass', summary: 'ok', achieved: ['planned'], issues: [], evidence_card_ids: ['card-1'], ...overrides } },
  };
}

function evaluate(store: CardStore, card: CardRecord, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>) {
  const planning: PlannerDoneResult = { kind: 'planner_done', summary: 'planned' };
  return evaluateReviewerTerminalOutcome({
    card,
    candidatePlanning: planning,
    assessmentId: 'assessment-card-1-1',
    sessionId: 'reviewer:card-1:assessment-card-1-1',
    outcome,
    store,
  });
}

describe('evaluateReviewerTerminalOutcome', () => {
  it('blocks self-citation when the reviewed card has no durable evidence', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);

    const outcome = evaluate(store, card, reviewerOutcome({ evidence_card_ids: [card.id] }));

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked', reviewer_correction: { kind: 'reviewer_correction', assessment_id: 'assessment-card-1-1' } } });
    expect(outcome.summary).toContain('without durable result');
  }));

  it('returns reviewer_pass when assessment cites done descendant evidence', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);
    const child = createDoneChild(store, card.id);

    const outcome = evaluate(store, card, reviewerOutcome({ evidence_card_ids: [child.id] }));

    expect(outcome).toMatchObject({ status: 'done', summary: 'ok', result: { kind: 'reviewer_pass', planning: { kind: 'planner_done', summary: 'planned' }, review_summary: 'ok', assessment_id: 'assessment-card-1-1' } });
  }));

  it('returns reviewer correction when reviewer asks for corrections', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);
    const child = createDoneChild(store, card.id);

    const outcome = evaluate(store, card, reviewerOutcome({ result: 'needs_corrections', summary: 'fix it', issues: [{ summary: 'missing proof', severity: 'blocker' }], evidence_card_ids: [child.id] }));

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'fix it', result: { kind: 'planner_blocked', resume_reason: 'reviewer_needs_corrections', reviewer_correction: { kind: 'reviewer_correction', assessment_id: 'assessment-card-1-1', summary: 'fix it', issues: [{ summary: 'missing proof', severity: 'blocker' }] } } });
  }));

  it('blocks invalid reviewer evidence instead of approving', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);

    const outcome = evaluate(store, card, reviewerOutcome({ evidence_card_ids: ['missing'] }));

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked', reviewer_correction: { kind: 'reviewer_correction', assessment_id: 'assessment-card-1-1' } } });
    expect(outcome.summary).toContain('missing');
  }));

  it('fails invalid terminal tool payloads', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);

    const outcome = evaluate(store, card, { ...reviewerOutcome({ evidence_card_ids: [card.id] }), args: { assessment: { summary: 'missing result' } } });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'planner_failure' } });
    expect(outcome.summary).toContain('reviewer');
  }));
});
