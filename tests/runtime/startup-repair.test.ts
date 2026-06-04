import { describe, expect, it } from '@jest/globals';
import { buildBlockedPlannerStartupState, buildChildRunStartupState, buildResumePlannerStartupState, buildReviewerInterruptedStartupState, decideStartupActiveRunRepair, executeStartupActiveRunRepairDecision, rehydrateStartupActivation, selectStartupPlannerRedispatchCardId, shouldRestartRunningIntentOnStartup, type StartupActiveRunRepairEffects } from '../../src/runtime/startup-repair.js';
import type { CardRecord, RuntimeState } from '../../src/schemas/types.js';

function state(run: NonNullable<RuntimeState['active_card_run']> | null): RuntimeState {
  return { active_card_run: run } as RuntimeState;
}

function run(phase: NonNullable<RuntimeState['active_card_run']>['phase']): NonNullable<RuntimeState['active_card_run']> {
  return { phase, card_id: 'card-a' } as NonNullable<RuntimeState['active_card_run']>;
}

const card = { id: 'card-a', status: 'running' } as unknown as CardRecord;

describe('startup active run repair decisions', () => {
  it('rehydrates startup activation snapshots from persisted active runs', () => {
    const snapshot = rehydrateStartupActivation(state(run('planner')));

    expect(snapshot?.run).toEqual(expect.objectContaining({ phase: 'planner', card_id: 'card-a' }));
    expect(snapshot?.activation.state).toEqual(expect.objectContaining({ phase: 'planner', cardId: 'card-a' }));
    expect(rehydrateStartupActivation(state(null))).toBeNull();
  });

  it('repairs orphan tool calls when no active run or card exists', () => {
    expect(decideStartupActiveRunRepair({ previousState: state(null), card: null, hasPersistedReview: false, cardHasBlockedPlanning: false, isTerminalCardStatus: false })).toEqual({ kind: 'repair_orphan_tool_calls', state: state(null) });
    expect(decideStartupActiveRunRepair({ previousState: state(run('planner')), card: null, hasPersistedReview: false, cardHasBlockedPlanning: false, isTerminalCardStatus: false }).kind).toBe('repair_orphan_tool_calls');
  });

  it('classifies interrupted reviewer and executor active runs', () => {
    expect(decideStartupActiveRunRepair({ previousState: state(run('reviewer')), card, hasPersistedReview: false, cardHasBlockedPlanning: false, isTerminalCardStatus: false }).kind).toBe('reviewer_interrupted');
    expect(decideStartupActiveRunRepair({ previousState: state(run('executor')), card, hasPersistedReview: false, cardHasBlockedPlanning: false, isTerminalCardStatus: false })).toEqual(expect.objectContaining({ kind: 'executor_interrupted', shouldFailCard: true }));
  });

  it('classifies terminal, blocked planner, and resumable planner runs', () => {
    expect(decideStartupActiveRunRepair({ previousState: state(run('planner')), card, hasPersistedReview: false, cardHasBlockedPlanning: false, isTerminalCardStatus: true }).kind).toBe('terminal_active_card');
    expect(decideStartupActiveRunRepair({ previousState: state(run('planner')), card, hasPersistedReview: false, cardHasBlockedPlanning: true, isTerminalCardStatus: false }).kind).toBe('blocked_planner');
    expect(decideStartupActiveRunRepair({ previousState: state(run('planner')), card, hasPersistedReview: false, cardHasBlockedPlanning: false, isTerminalCardStatus: false }).kind).toBe('resume_planner');
  });

  it('builds reviewer-interrupted startup repair state', () => {
    const previousState = { ...state(run('reviewer')), paused: true, paused_at: 'paused' } as RuntimeState;
    expect(buildReviewerInterruptedStartupState({ previousState, run: run('reviewer'), plannerSessionId: 'planner:card-a', at: 'now' })).toEqual(expect.objectContaining({
      status: 'running',
      current_card_id: 'card-a',
      current_agent_session_id: 'planner:card-a',
      paused: false,
      paused_at: null,
      updated_at: 'now',
      active_card_run: expect.objectContaining({ phase: 'planner', runtime_status: 'running', reviewer_session_id: null, last_turn_at: 'now' }),
    }));
  });

  it('builds child-run, blocked-planner, and resume-planner repair states', () => {
    const previousState = { ...state(run('executor')), paused: true, paused_at: 'paused' } as RuntimeState;
    const parentRun = { ...run('planner'), card_id: 'parent-a', planner_session_id: 'planner:parent-a' };

    expect(buildChildRunStartupState({ previousState, parentRun, at: 'now' })).toEqual(expect.objectContaining({
      status: 'running',
      current_card_id: 'parent-a',
      current_agent_session_id: 'planner:parent-a',
      active_card_run: parentRun,
      paused: false,
      paused_at: null,
    }));
    expect(buildChildRunStartupState({ previousState, parentRun: null, at: 'now' })).toEqual(expect.objectContaining({
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
    }));
    expect(buildBlockedPlannerStartupState({ previousState, at: 'now' })).toEqual(expect.objectContaining({
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
      paused: false,
      paused_at: null,
    }));
    expect(buildResumePlannerStartupState({ previousState, run: run('planner'), at: 'now' })).toEqual(expect.objectContaining({
      status: 'running',
      current_card_id: 'card-a',
      current_agent_session_id: 'planner:card-a',
      active_card_run: expect.objectContaining({ runtime_status: 'running', last_turn_at: 'now' }),
    }));
  });

  it('decides startup redispatch for running intent and active planner runs', () => {
    expect(shouldRestartRunningIntentOnStartup({
      state: {
        status: 'idle',
        current_card_id: null,
        active_card_run: null,
        runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: 't0' },
        runtime_runs: [{ run_id: 'root', kind: 'root', finished_at: 'done' }],
      } as RuntimeState,
      projectHasBlockedPlanning: false,
    })).toBe(true);
    expect(shouldRestartRunningIntentOnStartup({
      state: { runtime_intent: { status: 'running', updated_at: 't0' }, status: 'idle', runtime_runs: [{ kind: 'root' }] } as RuntimeState,
      projectHasBlockedPlanning: false,
    })).toBe(false);
    expect(selectStartupPlannerRedispatchCardId({
      state: state({ ...run('planner'), card_id: 'goal-a', runtime_status: 'running' }),
      activeCardHasBlockedPlanning: false,
    })).toBe('goal-a');
    expect(selectStartupPlannerRedispatchCardId({
      state: state({ ...run('planner'), card_id: 'goal-a', runtime_status: 'running' }),
      activeCardHasBlockedPlanning: true,
    })).toBeNull();
  });

  it('executes reviewer-interrupted repair through effect ports', async () => {
    const calls: string[] = [];
    const previousState = { ...state(run('reviewer')), paused: true, paused_at: 'paused' } as RuntimeState;
    const saved: RuntimeState[] = [];
    const effects = testEffects({
      transitionCard: async (cardId, event) => { calls.push(`${event}:${cardId}`); },
      queueSyntheticPlannerNote: (note) => { calls.push(`${note.kind}:${note.target_planner_session_id}`); },
      saveState: (nextState) => { saved.push(nextState); return nextState; },
    });

    const repaired = await executeStartupActiveRunRepairDecision({
      decision: { kind: 'reviewer_interrupted', run: run('reviewer') },
      previousState,
      effects,
    });

    expect(calls).toEqual(['reviewer_repair_resume:card-a', 'reviewer_interrupted:planner:card-a']);
    expect(repaired).toBe(saved[0]);
    expect(repaired).toEqual(expect.objectContaining({ status: 'running', current_agent_session_id: 'planner:card-a' }));
  });

  it('executes executor-interrupted repair through effect ports', async () => {
    const calls: string[] = [];
    const previousState = { ...state(run('executor')), paused: true, paused_at: 'paused' } as RuntimeState;
    const parentRun = { ...run('planner'), card_id: 'parent-a', planner_session_id: 'planner:parent-a' };
    const effects = testEffects({
      transitionCard: async (cardId, event) => { calls.push(`${event}:${cardId}`); },
      repairTerminalLifecycle: async (cardId, patch) => { calls.push(`repair:${cardId}:${patch.lifecycle?.error}`); },
      appendChildUnwindToolResult: (cardId, outcome) => { calls.push(`unwind:${cardId}:${outcome}`); },
      parentPlannerRunFor: () => parentRun,
    });

    const repaired = await executeStartupActiveRunRepairDecision({
      decision: { kind: 'executor_interrupted', run: run('executor'), card, shouldFailCard: true },
      previousState,
      effects,
    });

    expect(calls).toEqual([
      'fail:card-a',
      'repair:card-a:Execution interrupted by service restart.',
      'unwind:card-a:failed',
    ]);
    expect(repaired).toEqual(expect.objectContaining({ current_card_id: 'parent-a', current_agent_session_id: 'planner:parent-a' }));
  });
});

function testEffects(overrides: Partial<StartupActiveRunRepairEffects> = {}): StartupActiveRunRepairEffects {
  return {
    now: () => 'now',
    repairOrphanActivateCardToolCalls: () => undefined,
    transitionCard: async () => undefined,
    repairTerminalLifecycle: async () => undefined,
    appendChildUnwindToolResult: () => undefined,
    parentPlannerRunFor: () => null,
    findCallerEdge: () => null,
    synthesizeTerminalActivationResult: () => false,
    finishOpenPlannerRun: () => undefined,
    queueSyntheticPlannerNote: () => undefined,
    saveState: (nextState) => nextState,
    ...overrides,
  };
}
