import { describe, expect, it } from '@jest/globals';

import { buildXStateExecutorInput, buildXStatePlannerInput, buildXStateReviewerInput } from '../../../src/runtime/actors/index.js';
import type { RuntimeContextCardReader } from '../../../src/runtime/context-builder.js';
import type { CardRecord } from '../../../src/schemas/types.js';

describe('XState actor input builders', () => {
  it('builds planner input with goal context and evidence context', () => {
    const cards = makeCardReader([
      card({ id: 'project', type: 'project', parent: null, depth: 0, title: 'Project', description: 'Project objective' }),
      card({ id: 'goal-a', type: 'goal', parent: 'project', depth: 1, title: 'Goal A', description: 'Plan the feature' }),
      card({ id: 'child-a', type: 'code', parent: 'goal-a', depth: 2, title: 'Child A', description: 'Implement the feature', status: 'done' }),
    ]);

    const input = buildXStatePlannerInput({
      inputId: 'planner-input:goal-a',
      card: { id: 'goal-a', type: 'goal' },
      sourceCommandId: 'cmd-1',
      context: { cards },
    });

    expect(input).toEqual(expect.objectContaining({
      inputId: 'planner-input:goal-a',
      role: 'planner',
      sessionId: 'planner:goal-a',
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: 'goal-a', cardType: 'goal', sourceCommandId: 'cmd-1' },
    }));
    expect(input.systemPrompt).toContain('## Goal Context');
    expect(input.systemPrompt).toContain('Plan the feature');
    expect(input.systemPrompt).toContain('## Goal Evidence Context');
    expect(input.systemPrompt).toContain('child-a');
    expect(input.systemPrompt).toContain('result_summary');
  });

  it('builds executor input with card context', () => {
    const cards = makeCardReader([
      card({ id: 'goal-a', type: 'goal', parent: 'project', depth: 1, title: 'Goal A', description: 'Build product' }),
      card({ id: 'card-a', type: 'code', parent: 'goal-a', depth: 2, title: 'Card A', description: 'Implement feature', tags: ['ts'] }),
    ]);

    const input = buildXStateExecutorInput({
      inputId: 'executor-input:card-a',
      card: { id: 'card-a', type: 'code' },
      goalId: 'goal-a',
      context: { cards },
    });

    expect(input).toEqual(expect.objectContaining({
      inputId: 'executor-input:card-a',
      role: 'executor',
      sessionId: 'executor:card-a',
      capabilityRequest: { requiresTools: false },
      episodeContext: { cardId: 'card-a', cardType: 'code' },
    }));
    expect(input.systemPrompt).toContain('## Card Context');
    expect(input.systemPrompt).toContain('Implement feature');
    expect(input.systemPrompt).toContain('Build product');
  });

  it('builds reviewer input with goal context and planner summary metadata', () => {
    const cards = makeCardReader([
      card({ id: 'goal-a', type: 'goal', parent: 'project', depth: 1, title: 'Goal A', description: 'Review goal' }),
      card({ id: 'evidence-a', type: 'test', parent: 'goal-a', depth: 2, title: 'Evidence A', description: 'Verification evidence', status: 'done' }),
    ]);

    const input = buildXStateReviewerInput({
      inputId: 'reviewer-input:goal-a',
      card: { id: 'goal-a', type: 'goal' },
      plannerSummary: 'Planner says ready for review',
      context: { cards },
    });

    expect(input).toEqual(expect.objectContaining({
      inputId: 'reviewer-input:goal-a',
      role: 'reviewer',
      sessionId: 'reviewer:goal-a',
      capabilityRequest: { requiresTools: false },
      episodeContext: { cardId: 'goal-a', cardType: 'goal', plannerSummary: 'Planner says ready for review' },
    }));
    expect(input.systemPrompt).toContain('## Goal Context');
    expect(input.systemPrompt).toContain('Review goal');
    expect(input.systemPrompt).toContain('## Goal Evidence Context');
    expect(input.systemPrompt).toContain('evidence-a');
    expect(input.systemPrompt).toContain('result_summary');
  });
});

function makeCardReader(records: CardRecord[]): RuntimeContextCardReader {
  const cards = new Map(records.map((record) => [record.id, record]));
  return {
    read: (cardId) => cards.get(cardId) ?? null,
    listChildren: (cardId) => records.filter((record) => record.parent === cardId).map((record) => record.id),
    blocksFor: () => [],
  };
}

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: 'card',
    type: 'goal',
    parent: 'project',
    depth: 0,
    title: 'Card',
    description: '',
    status: 'backlog',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    depends_on: [],
    related: [],
    artifacts: [],
    attachments: [],
    acceptance: '',
    retries: 0,
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    ...overrides,
  } as CardRecord;
}
