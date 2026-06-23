import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { ReviewerCardProcessorActor, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { CardRecord } from '../../../src/schemas/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-reviewer-processor-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function createProject(store: CardStore): CardRecord {
  return store.create({ type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
}

function createGoalWithPlannerResult(store: CardStore): CardRecord {
  const goal = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'goal', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  return store.commitTerminalLifecyclePatch(goal.id, {
    status: 'done',
    lifecycle: { status: 'done', result: { kind: 'planner_done', summary: 'planned' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' },
  });
}

function reviewerMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ result: 'pass', summary: 'ok', achieved: ['planned'], issues: [], evidence_card_ids: ['card-1'], ...overrides });
}

function reviewerResult(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: 'reviewer-result-1', type: 'function' as const, function: { name: 'emit_reviewer_result', arguments: JSON.stringify({ assessment: { result: 'pass', summary: 'ok', achieved: ['planned'], issues: [], evidence_card_ids: ['card-1'], ...overrides } }) } }],
  };
}

describe('ReviewerCardProcessorActor', () => {
  it('returns reviewer_pass when assessment passes validation', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoalWithPlannerResult(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => reviewerResult({ evidence_card_ids: [goal.id] })) };
    const actor = new ReviewerCardProcessorActor({ projectRoot, cardId: goal.id, store, provider });
    actor.start();

    const outcome = await actor.activate({ card: goal, caller: { kind: 'parent', cardId: 'project' }, notifications: [] });

    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'reviewer_pass', planning: { kind: 'planner_done' }, review_summary: 'ok' } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.stringContaining('assessment-card-1-1'), terminalToolNames: ['emit_reviewer_result'], tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'emit_reviewer_result' }) })]) }), expect.any(AbortSignal));
  }));

  it('returns blocked reviewer correction when reviewer asks for corrections', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoalWithPlannerResult(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => reviewerResult({ result: 'needs_corrections', summary: 'fix it', issues: [{ summary: 'missing proof', severity: 'blocker' }], evidence_card_ids: [goal.id] })) };
    const actor = new ReviewerCardProcessorActor({ projectRoot, cardId: goal.id, store, provider });
    actor.start();

    const outcome = await actor.activate({ card: goal, caller: { kind: 'parent', cardId: 'project' }, notifications: [] });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'fix it', result: { kind: 'planner_blocked', reviewer_correction: { kind: 'reviewer_correction', summary: 'fix it' } } });
  }));

  it('blocks invalid reviewer evidence instead of guessing approval', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoalWithPlannerResult(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => reviewerResult({ evidence_card_ids: ['missing'] })) };
    const actor = new ReviewerCardProcessorActor({ projectRoot, cardId: goal.id, store, provider });
    actor.start();

    const outcome = await actor.activate({ card: goal, caller: { kind: 'parent', cardId: 'project' }, notifications: [] });

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked' } });
    expect(outcome.summary).toContain('missing');
  }));

  it('does not accept plain reviewer JSON as terminal assessment', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoalWithPlannerResult(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: reviewerMessage({ evidence_card_ids: [goal.id] }) })) };
    const actor = new ReviewerCardProcessorActor({ projectRoot, cardId: goal.id, store, provider });
    actor.start();

    const outcome = await actor.activate({ card: goal, caller: { kind: 'parent', cardId: 'project' }, notifications: [] });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'planner_failure' } });
    expect(outcome.summary).toContain('emit_reviewer_result');
  }));
});
