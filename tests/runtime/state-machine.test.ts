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

function buildMachine(projectRoot: string, opts?: { enforceInvariants?: boolean; clock?: () => Date }): { machine: RuntimeStateMachine; scheduler: FakeScheduler; errorLogger: ErrorLogger } {
  const cardStore = new CardStore(projectRoot);
  const errorLogger = new ErrorLogger(join(projectRoot, '.saivage'));
  const scheduler = new FakeScheduler();
  const machine = new RuntimeStateMachine({
    cardStore,
    readState: () => readRuntimeState(projectRoot),
    writeState: (changes: Partial<RuntimeState>) => updateRuntimeState(projectRoot, changes),
    errorLogger,
    clock: opts?.clock ?? (() => new Date()),
    scheduler,
    redispatchGoal: () => { /* noop */ },
    enforceInvariants: opts?.enforceInvariants ?? false,
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
        cardStore,
        readState: () => readRuntimeState(projectRoot),
        writeState: (changes: Partial<RuntimeState>) => updateRuntimeState(projectRoot, changes),
        errorLogger,
        clock,
        scheduler,
        redispatchGoal: () => undefined,
        enforceInvariants: false,
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

  it('enforceInvariants: false does not auto-correct an I1 violation; logs once', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      // Force an I1 violation: status === 'running' with active_card_run null.
      updateRuntimeState(projectRoot, { status: 'running', active_card_run: null });
      const { machine, errorLogger } = buildMachine(projectRoot, { enforceInvariants: false });
      await machine.tick();
      const stateAfter = readRuntimeState(projectRoot)!;
      // Observe-only: status must NOT have been corrected.
      expect(stateAfter.status).toBe('running');
      const i1 = errorLogger.getErrors().filter((e) => e.code === 'state_machine_invariant' && e.invariant === 'I1');
      expect(i1.length).toBe(1);
      // A second tick must not produce another log line (dedup by tuple).
      await machine.tick();
      const i1Again = errorLogger.getErrors().filter((e) => e.code === 'state_machine_invariant' && e.invariant === 'I1');
      expect(i1Again.length).toBe(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
