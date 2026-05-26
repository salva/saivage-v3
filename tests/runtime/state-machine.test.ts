import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStateMachine, type RuntimeScheduler, type RuntimeSchedulerHandle } from '../../src/runtime/state-machine.js';
import { initRuntimeState, readRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { CardStore } from '../../src/cards/card-store.js';
import { ErrorLogger } from '../../src/observability/error-logger.js';
import type { RuntimeState } from '../../src/schemas/types.js';

function root(): string { return mkdtempSync(join(tmpdir(), 'saivage-state-machine-')); }

class FakeScheduler implements RuntimeScheduler {
  handlers: Array<{ handle: RuntimeSchedulerHandle; fn: () => void; ms: number; active: boolean }> = [];
  setInterval(fn: () => void, ms: number): RuntimeSchedulerHandle {
    const handle = {} as RuntimeSchedulerHandle;
    this.handlers.push({ handle, fn, ms, active: true });
    return handle;
  }
  clearInterval(handle: RuntimeSchedulerHandle): void {
    const entry = this.handlers.find((h) => h.handle === handle);
    if (entry) entry.active = false;
  }
  async fire(handle: RuntimeSchedulerHandle): Promise<void> {
    const entry = this.handlers.find((h) => h.handle === handle && h.active);
    if (entry) {
      entry.fn();
      // Allow the void-returning fn() body (an async tick()) to flush.
      await new Promise((r) => setImmediate(r));
    }
  }
}

function buildMachine(projectRoot: string, opts?: { clock?: () => Date }): { machine: RuntimeStateMachine; scheduler: FakeScheduler; errorLogger: ErrorLogger } {
  const cardStore = new CardStore(projectRoot);
  const errorLogger = new ErrorLogger(join(projectRoot, '.saivage'));
  const scheduler = new FakeScheduler();
  const machine = new RuntimeStateMachine({
    cards: {
      readStatus: (cardId) => cardStore.read(cardId)?.status,
      canTransition: (from, to) => cardStore.canTransition(from, to),
      setStatus: (cardId, status) => { cardStore.setStatus(cardId, status); },
    },
    state: {
      read: () => readRuntimeState(projectRoot),
      patch: (changes: Partial<RuntimeState>) => updateRuntimeState(projectRoot, changes),
    },
    errors: errorLogger,
    clock: { now: opts?.clock ?? (() => new Date()) },
    scheduler,
    redispatch: { redispatch: () => { /* noop */ } },
    tickIntervalMs: 5000,
  });
  return { machine, scheduler, errorLogger };
}

describe('RuntimeStateMachine (Step 2 skeleton)', () => {
  it('start() registers an interval with the injected scheduler; stop() clears it', () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const { machine, scheduler } = buildMachine(projectRoot);
      machine.start();
      expect(scheduler.handlers.length).toBe(1);
      expect(scheduler.handlers[0]!.active).toBe(true);
      expect(scheduler.handlers[0]!.ms).toBe(5000);
      machine.stop();
      expect(scheduler.handlers[0]!.active).toBe(false);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('tick() stamps last_tick_at on disk', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const fixed = new Date('2026-05-24T10:00:00.000Z');
      const { machine } = buildMachine(projectRoot, { clock: () => fixed });
      await machine.tick();
      const state = readRuntimeState(projectRoot)!;
      expect(state.last_tick_at).toBe(fixed.toISOString());
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('on-demand transition(\'tick\') is gated by the re-entrancy lock', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      let ticks = 0;
      // Inject a clock side-effect that re-enters transition('tick') during the
      // first call; the re-entrancy lock must short-circuit the second call.
      const machineRef: { current: RuntimeStateMachine | null } = { current: null };
      const clock = jest.fn<() => Date>(() => {
        ticks += 1;
        if (ticks === 1 && machineRef.current !== null) {
          void machineRef.current.transition('tick');
        }
        return new Date('2026-05-24T10:00:00.000Z');
      });
      const cardStore = new CardStore(projectRoot);
      const errorLogger = new ErrorLogger(join(projectRoot, '.saivage'));
      const scheduler = new FakeScheduler();
      const machine = new RuntimeStateMachine({
        cards: {
          readStatus: (cardId) => cardStore.read(cardId)?.status,
          canTransition: (from, to) => cardStore.canTransition(from, to),
          setStatus: (cardId, status) => { cardStore.setStatus(cardId, status); },
        },
        state: {
          read: () => readRuntimeState(projectRoot),
          patch: (changes: Partial<RuntimeState>) => updateRuntimeState(projectRoot, changes),
        },
        errors: errorLogger,
        clock: { now: clock },
        scheduler,
        redispatch: { redispatch: () => undefined },
      });
      machineRef.current = machine;
      await machine.tick();
      // Exactly one clock observation should have been made; the re-entrant
      // call short-circuited before reading the clock a second time.
      expect(clock).toHaveBeenCalledTimes(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('logs exactly one state_machine_invariant for an I4 backwards-clock violation', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const times = [
        new Date('2026-05-24T10:00:05.000Z'),
        new Date('2026-05-24T10:00:00.000Z'), // backwards
        new Date('2026-05-24T10:00:00.000Z'), // still backwards, but same tuple — must not double-log
      ];
      let idx = 0;
      const { machine, errorLogger } = buildMachine(projectRoot, { clock: () => times[idx++]! });
      await machine.tick();
      await machine.tick();
      await machine.tick();
      const errs = errorLogger.getErrors().filter((e) => e.code === 'state_machine_invariant' && e.invariant === 'I4');
      expect(errs.length).toBe(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('I1 auto-corrects status=running with active_card_run null to idle; logs once', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      // Force an I1 violation: status === 'running' with active_card_run null.
      updateRuntimeState(projectRoot, { status: 'running', active_card_run: null });
      const { machine, errorLogger } = buildMachine(projectRoot);
      await machine.tick();
      const stateAfter = readRuntimeState(projectRoot)!;
      // Always-enforce: status corrected to idle.
      expect(stateAfter.status).toBe('idle');
      const i1 = errorLogger.getErrors().filter((e) => e.code === 'state_machine_invariant' && e.invariant === 'I1');
      expect(i1.length).toBe(1);
      // A second tick must not produce another log line (dedup by tuple).
      await machine.tick();
      const i1Again = errorLogger.getErrors().filter((e) => e.code === 'state_machine_invariant' && e.invariant === 'I1');
      expect(i1Again.length).toBe(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});

describe('RuntimeStateMachine.transitionCard (Step 5 decomposition)', () => {
  function seed(cardStore: CardStore, id: string, status: import('../../src/schemas/types.js').CardStatus): void {
    cardStore.create({
      id,
      type: 'code',
      parent: null,
      title: 't',
      description: 'd',
      status,
      depends_on: [],
      priority: 5,
      tags: [],
      urgency: 'normal',
      created_by: 'planner',
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
      depth: 0,
      blocks: [],
    });
  }

  function build(projectRoot: string): { cardStore: CardStore; machine: RuntimeStateMachine; setStatusCalls: Array<{ id: string; status: string }>; errorLogger: ErrorLogger } {
    const cardStore = new CardStore(projectRoot);
    const errorLogger = new ErrorLogger(join(projectRoot, '.saivage'));
    const scheduler = new FakeScheduler();
    const setStatusCalls: Array<{ id: string; status: string }> = [];
    const origSetStatus = cardStore.setStatus.bind(cardStore);
    jest.spyOn(cardStore, 'setStatus').mockImplementation((id: string, status: import('../../src/schemas/types.js').CardStatus) => {
      setStatusCalls.push({ id, status });
      return origSetStatus(id, status);
    });
    const machine = new RuntimeStateMachine({
      cards: {
        readStatus: (cardId) => cardStore.read(cardId)?.status,
        canTransition: (from, to) => cardStore.canTransition(from, to),
        setStatus: (cardId, status) => { cardStore.setStatus(cardId, status); },
      },
      state: {
        read: () => readRuntimeState(projectRoot),
        patch: (changes: Partial<RuntimeState>) => updateRuntimeState(projectRoot, changes),
      },
      errors: errorLogger,
      clock: { now: () => new Date() },
      scheduler,
      redispatch: { redispatch: () => undefined },
    });
    return { cardStore, machine, setStatusCalls, errorLogger };
  }

  const cases: Array<{ name: string; from: import('../../src/schemas/types.js').CardStatus; action: import('../../src/runtime/state-machine.js').RuntimeCardAction; payload?: Record<string, unknown>; expected: import('../../src/schemas/types.js').CardStatus[] }> = [
    { name: 'start from drafting', from: 'drafting', action: 'start', expected: ['backlog', 'active', 'running'] },
    { name: 'start from backlog', from: 'backlog', action: 'start', expected: ['active', 'running'] },
    { name: 'restart from failed', from: 'failed', action: 'restart', expected: ['backlog', 'active', 'running'] },
    { name: 'restart from cancelled', from: 'cancelled', action: 'restart', expected: ['drafting', 'backlog', 'active', 'running'] },
    { name: 'fail from running', from: 'running', action: 'fail', expected: ['failed'] },
    { name: 'fail from drafting', from: 'drafting', action: 'fail', expected: ['backlog', 'active', 'running', 'failed'] },
    { name: 'block from active', from: 'active', action: 'block', expected: ['running', 'blocked'] },
    { name: 'block from running', from: 'running', action: 'block', expected: ['blocked'] },
    { name: 'complete from active', from: 'active', action: 'complete', expected: ['running', 'done'] },
    { name: 'complete from running', from: 'running', action: 'complete', expected: ['done'] },
    { name: 'cancel from blocked', from: 'blocked', action: 'cancel', expected: ['cancelled'] },
    { name: 'executor_finish done', from: 'running', action: 'executor_finish', payload: { finalStatus: 'done' }, expected: ['done'] },
    { name: 'executor_finish failed', from: 'running', action: 'executor_finish', payload: { finalStatus: 'failed' }, expected: ['failed'] },
    { name: 'executor_partial_finish from running', from: 'running', action: 'executor_partial_finish', expected: ['needs_verification'] },
    { name: 'reviewer_repair_resume from active', from: 'active', action: 'reviewer_repair_resume', expected: ['running'] },
    { name: 'reviewer_repair_resume from running (no-op)', from: 'running', action: 'reviewer_repair_resume', expected: [] },
    { name: 'crash_recovery_drop_to_backlog from running', from: 'running', action: 'crash_recovery_drop_to_backlog', expected: ['backlog'] },
    { name: 'crash_recovery_drop_to_backlog from active', from: 'active', action: 'crash_recovery_drop_to_backlog', expected: ['backlog'] },
    { name: 'planner_set_status failed→backlog', from: 'failed', action: 'planner_set_status', payload: { requestedStatus: 'backlog' }, expected: ['backlog'] },
    { name: 'planner_set_status same status (no-op)', from: 'backlog', action: 'planner_set_status', payload: { requestedStatus: 'backlog' }, expected: [] },
  ];

  it.each(cases)('emits expected setStatus sequence: $name', async ({ from, action, payload, expected }) => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const { cardStore, machine, setStatusCalls } = build(projectRoot);
      seed(cardStore, 'c1', from);
      const ok = await machine.transitionCard('c1', action, payload);
      expect(ok).toBe(true);
      expect(setStatusCalls.map((c) => c.status)).toEqual(expected);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('rejects unsupported source state for fail and logs state_machine_invalid_source_state', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const { cardStore, machine, setStatusCalls, errorLogger } = build(projectRoot);
      seed(cardStore, 'c1', 'done');
      const ok = await machine.transitionCard('c1', 'fail');
      expect(ok).toBe(false);
      expect(setStatusCalls.length).toBe(0);
      const errs = errorLogger.getErrors().filter((e) => e.code === 'state_machine_invalid_source_state');
      expect(errs.length).toBe(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('rejects planner_set_status when target is not a valid transition and logs state_machine_planner_status_rejected', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const { cardStore, machine, setStatusCalls, errorLogger } = build(projectRoot);
      seed(cardStore, 'c1', 'done');
      const ok = await machine.transitionCard('c1', 'planner_set_status', { requestedStatus: 'running' });
      expect(ok).toBe(false);
      expect(setStatusCalls.length).toBe(0);
      const errs = errorLogger.getErrors().filter((e) => e.code === 'state_machine_planner_status_rejected');
      expect(errs.length).toBe(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
