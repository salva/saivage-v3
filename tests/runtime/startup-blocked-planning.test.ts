import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignBlockedPlanningCardStatuses } from '../../src/runtime/startup-blocked-planning.js';
import type { CardRecord } from '../../src/schemas/index.js';
import type { RuntimeStateMutationPort } from '../../src/runtime/mutations.js';
import { updateRuntimeState } from '../../src/runtime/state.js';

const planning = { kind: 'planner_blocked', blocked_reason: 'Need operator input', resume_reason: 'planner_blocked' } as const;

function card(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'goal-a',
    type: 'goal',
    status: 'active',
    lifecycle: { status: 'active', result: planning, error: 'Need operator input', completed_at: null },
    ...overrides,
  } as CardRecord;
}

function deps(cards: CardRecord[], projectRoot = '/no-runtime-state-here') {
  const calls: string[] = [];
  return {
    calls,
    input: {
      cards: {
        list: () => cards,
        repairTerminalLifecycle: async (cardId: string) => { calls.push(`repair:${cardId}`); },
      },
      transitionCard: async (cardId: string) => { calls.push(`block:${cardId}`); },
      finishOpenPlannerRun: (goalId: string) => { calls.push(`finish:${goalId}`); },
      projectRoot,
      mutations: { apply: () => { calls.push('patch-runtime'); return undefined as never; } } as RuntimeStateMutationPort,
    },
  };
}

function withActivePlannerRun(cardId: string): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-startup-blocked-'));
  updateRuntimeState(projectRoot, {
    status: 'running',
    active_card_run: {
      card_id: cardId,
      card_type: 'goal',
      ownership: { kind: 'direct', source: 'project_root' },
      runtime_status: 'running',
      phase: 'planner',
      caller_session_id: null,
      caller_tool_call_id: null,
      planner_session_id: `planner:${cardId}`,
      correction_attempts: 0,
      started_at: '2026-01-01T00:00:00.000Z',
      last_turn_at: '2026-01-01T00:00:00.000Z',
    },
  });
  return projectRoot;
}

describe('startup blocked-planning alignment', () => {
  it('blocks active interrupted planner cards with blocked-planning metadata', async () => {
    const projectRoot = withActivePlannerRun('goal-a');
    const setup = deps([card()], projectRoot);

    try {
      await alignBlockedPlanningCardStatuses(setup.input);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }

    expect(setup.calls).toEqual(['block:goal-a', 'finish:goal-a', 'repair:goal-a', 'patch-runtime']);
  });

  it('fails startup for active blocked-planning metadata without persisted planner ownership', async () => {
    const setup = deps([card()]);

    await expect(alignBlockedPlanningCardStatuses(setup.input)).rejects.toThrow("blocked-planning metadata without persisted planner ownership");
  });

  it('aligns already blocked planning cards without rewriting lifecycle', async () => {
    const setup = deps([card({ status: 'blocked', lifecycle: { status: 'blocked', result: planning, error: 'Need operator input', completed_at: null } })]);

    await alignBlockedPlanningCardStatuses(setup.input);

    expect(setup.calls).toEqual(['finish:goal-a']);
  });

  it('fails startup for terminal cards with blocked-planning metadata', async () => {
    const setup = deps([card({ status: 'done', lifecycle: { status: 'done', result: planning, error: null, completed_at: '2026-01-01T00:00:00.000Z' } as any })]);

    await expect(alignBlockedPlanningCardStatuses(setup.input)).rejects.toThrow("terminal card 'goal-a' has blocked-planning metadata");
  });

  it('fails startup when card status and lifecycle disagree', async () => {
    const setup = deps([card({ status: 'blocked', lifecycle: { status: 'active', result: planning, error: 'Need operator input', completed_at: null } })]);

    await expect(alignBlockedPlanningCardStatuses(setup.input)).rejects.toThrow("status 'blocked' contradicts lifecycle status 'active'");
  });
});
