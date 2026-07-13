import { initProjectTree, CardStore } from '../../helpers/canonical-project.js';
import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { evaluateReviewerTerminalOutcome } from '../../../src/runtime/actors/reviewer-terminal-evaluation.js';
import type { LLMActorOutcome } from '../../../src/runtime/actors/index.js';
import type { CardRecord } from '../../../src/schemas/index.js';

function withTempProject<T>(fn: (projectRoot: string) => T): T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-reviewer-terminal-'));
  try {
    return fn(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function createProject(store: CardStore): CardRecord {
  const project = store.read('project');
  if (!project) throw new Error('project card not found');
  return project;
}

function createDoneChild(store: CardStore, parent: string): CardRecord {
  const child = store.create({ type: 'goal', parent, depth: 1, title: 'child', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  return store.commitTerminalLifecyclePatch(child.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'child done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
}

function reviewerOutcome(overrides: Record<string, unknown> = {}): Extract<LLMActorOutcome, { type: 'tool_call' }> {
  return {
    type: 'tool_call',
    agentId: 'reviewer:card-1',
    inputId: 'reviewer:card-1:1',
    toolCallId: 'reviewer-result-1',
    toolName: 'emit_result',
    args: { status: 'done', summary: 'ok', ...overrides },
  };
}

function evaluate(outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>) {
  return evaluateReviewerTerminalOutcome({ outcome });
}

describe('evaluateReviewerTerminalOutcome', () => {
  it('returns done for done reviewer status', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);

    const outcome = evaluate(reviewerOutcome());

    expect(outcome).toMatchObject({ status: 'done', summary: 'ok', result: { kind: 'done', summary: 'ok' } });
  }));

  it('does not require terminal evidence fields for done', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);
    createDoneChild(store, card.id);

    const outcome = evaluate(reviewerOutcome());

    expect(outcome).toMatchObject({ status: 'done', summary: 'ok', result: { kind: 'done', summary: 'ok' } });
  }));

  it('returns reviewer correction when reviewer asks for corrections', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);
    createDoneChild(store, card.id);

    const outcome = evaluate(reviewerOutcome({ status: 'rework', summary: 'fix it' }));

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'fix it', result: { kind: 'rework', summary: 'fix it' } });
  }));

  it('returns planner blocked when reviewer status is blocked', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);

    const outcome = evaluate(reviewerOutcome({ status: 'blocked', summary: 'review blocked' }));

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'review blocked', result: { kind: 'blocked', resume_reason: 'reviewer_blocked' } });
  }));

  it('fails invalid terminal tool payloads', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const card = createProject(store);

    const outcome = evaluate({ ...reviewerOutcome(), args: { summary: 'missing status' } });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'failed' } });
    expect(outcome.summary).toContain('reviewer');
  }));
});
