import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore } from '../../src/cards/card-store.js';
import { completeSession, createSession, getSession, getSessionMessages, markSessionWaiting } from '../../src/runtime/session-persistence.js';
import { EventLogger } from '../../src/observability/index.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createRuntimeStateMutationPort } from '../../src/runtime/mutations.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { performRuntimeStartup } from '../../src/runtime/runtime-startup.js';
import { readRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

describe('runtime startup session sweep', () => {
  let projectRoot: string;
  let saivageDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-startup-sweep-'));
    saivageDir = join(projectRoot, '.saivage');
    initProjectTree(projectRoot);
    materializeProjectCard(projectRoot);
  });

  afterEach(() => {
    try { releaseLock(projectRoot); } catch { /* ignore unlocked temp projects */ }
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('sweeps active non-analyst sessions, logs one sweep event, and clears swept active runtime state', async () => {
    const activeExecutor = createSession(saivageDir, 'executor', 'goal-1', 'card-1');
    const activeReviewer = createSession(saivageDir, 'reviewer', 'goal-1', 'goal-1');
    const activePlanner = createSession(saivageDir, 'planner', 'goal-1', 'goal-1');
    const waitingPlanner = createSession(saivageDir, 'planner', 'goal-2', 'goal-2');
    const doneExecutor = createSession(saivageDir, 'executor', 'goal-1', 'card-3');
    const analyst = createSession(saivageDir, 'analyst');
    markSessionWaiting(saivageDir, waitingPlanner.id);
    completeSession(saivageDir, doneExecutor.id, 'done');
    const waitingBefore = readFileSync(join(saivageDir, 'agents', 'sessions', `${waitingPlanner.id}.json`), 'utf8');
    const analystBefore = readFileSync(join(saivageDir, 'agents', 'sessions', `${analyst.id}.json`), 'utf8');
    updateRuntimeState(projectRoot, {
      status: 'running',
      active_card_run: {
        card_id: 'goal-1',
        card_type: 'goal',
        ownership: { kind: 'direct', source: 'project_root' },
        runtime_status: 'running',
        phase: 'planner',
        caller_session_id: null,
        caller_tool_call_id: null,
        planner_session_id: activePlanner.id,
        correction_attempts: 0,
        started_at: new Date().toISOString(),
        last_turn_at: new Date().toISOString(),
      },
    });
    const emitted: Array<{ kind: string; payload: unknown }> = [];
    const eventLogger = new EventLogger(saivageDir);

    await performRuntimeStartup({
      projectRoot,
      cards: new CardStore(projectRoot),
      stateMachine: {
        start: () => undefined,
        transitionCard: async () => true,
        requestImmediateTick: async () => undefined,
      } as never,
      runLedger: { finishOpenPlannerRun: () => null } as never,
      projectCommands: { startProject: async () => undefined } as never,
      supervisor: { start: () => undefined } as never,
      events: {
        emit: (kind: string, payload: unknown) => { emitted.push({ kind, payload }); },
        publishRuntimeLedgerEvent: () => undefined,
      } as never,
      eventLogger,
      mutations: createRuntimeStateMutationPort(projectRoot),
      lifecycle: { running: false, paused: false, shuttingDown: false, dispatchInFlight: new Set(), dispatchPromises: new Map() },
      repairStartupActiveCardRun: async () => readRuntimeState(projectRoot),
      dispatchGoalThroughScheduler: async () => undefined,
      trackBackgroundDispatch: () => undefined,
    });

    for (const sessionId of [activeExecutor.id, activeReviewer.id, activePlanner.id]) {
      expect(getSession(saivageDir, sessionId)?.status).toBe('failed');
      expect(getSessionMessages(saivageDir, sessionId)).toEqual([
        expect.objectContaining({ role: 'system', kind: 'model_issue' }),
      ]);
    }
    expect(readFileSync(join(saivageDir, 'agents', 'sessions', `${waitingPlanner.id}.json`), 'utf8')).toBe(waitingBefore);
    expect(readFileSync(join(saivageDir, 'agents', 'sessions', `${analyst.id}.json`), 'utf8')).toBe(analystBefore);
    expect(getSession(saivageDir, doneExecutor.id)?.status).toBe('done');
    const expectedSweptIds = [activeExecutor.id, activeReviewer.id, activePlanner.id].sort();
    const emittedSweep = emitted.find((event) => event.kind === 'startup_session_sweep');
    expect((emittedSweep?.payload as { swept_session_ids?: string[] }).swept_session_ids?.sort()).toEqual(expectedSweptIds);
    const [loggedSweep] = eventLogger.getEvents({ kind: 'startup_session_sweep' });
    expect(loggedSweep).toEqual(expect.objectContaining({ kind: 'startup_session_sweep' }));
    expect((loggedSweep as unknown as { swept_session_ids: string[] }).swept_session_ids.sort()).toEqual(expectedSweptIds);
    expect(readRuntimeState(projectRoot)?.active_card_run).toBeNull();
  });
});
