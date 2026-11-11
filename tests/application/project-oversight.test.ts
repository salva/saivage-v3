import { ProjectOversight, type OversightClock } from '../../src/application/project-oversight.js';
import { describe, expect, it, jest } from '@jest/globals';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';

class Clock implements OversightClock {
  now = 0;
  wall = '2026-09-14T00:00:00.000Z';
  next = 1;
  timers = new Map<number, { at: number; delay: number; callback: () => void }>();
  monotonicNow = () => this.now;
  wallNow = () => new Date(Date.parse(this.wall) + this.now).toISOString();
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + delay, delay, callback });
    return id;
  };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  adjustWall(ms: number) { this.wall = new Date(Date.parse(this.wall) + ms).toISOString(); }
  advance(ms: number) { this.now += ms; this.dispatch(); }
  dispatch() {
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= this.now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}
const deferred = () => {
  let resolve!: (value: 'succeeded' | 'failed' | 'cancelled') => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<'succeeded' | 'failed' | 'cancelled'>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(input: { enabled?: boolean; interval?: number } = {}) {
  const clock = new Clock();
  const checks: Array<ReturnType<typeof deferred> & { cancelled: boolean }> = [];
  const changed = jest.fn();
  const failures: unknown[] = [];
  const owner = new ProjectOversight({
    enabled: input.enabled ?? true, intervalMs: input.interval ?? 1000,
    agentName: 'oversight', sessionId: 'agent:oversight:global', serviceEpoch: clock.wall,
    clock, changed, onOwnerFailure(error) { failures.push(error); },
    createCheck() {
      const task = { ...deferred(), cancelled: false }; checks.push(task);
      return { run: () => task.promise, cancel() { task.cancelled = true; }, executingLlmSnapshot: () => null } as never;
    },
  });
  return { clock, checks, changed, failures, owner };
}

describe('ProjectOversight deterministic schedule ownership', () => {
  it('waits a full interval, never queues ticks, and rearms from settlement', async () => {
    const { clock, checks, owner } = fixture();
    owner.runtimeStatusChanged('running');
    expect(owner.status()).toMatchObject({ state: 'waiting', remaining_wait_ms: 1000 });
    clock.advance(999); expect(checks).toHaveLength(0);
    clock.advance(1); expect(checks).toHaveLength(1);
    expect(owner.status()).toMatchObject({ state: 'checking', eligibility_reason: 'check_in_flight', remaining_wait_ms: null });
    clock.advance(5000); expect(checks).toHaveLength(1);
    checks[0]!.resolve('succeeded'); await Promise.resolve();
    expect(owner.status()).toMatchObject({ state: 'waiting', last_attempt: { outcome: 'succeeded' }, remaining_wait_ms: 1000 });
    clock.advance(999); expect(checks).toHaveLength(1);
    clock.advance(1); expect(checks).toHaveLength(2);
  });

  it('settles an ordinary failed check and waits another full interval', async () => {
    const { clock, checks, owner } = fixture();
    owner.runtimeStatusChanged('running'); clock.advance(1000);
    checks[0]!.resolve('failed'); await Promise.resolve();
    expect(owner.status()).toMatchObject({ state: 'waiting', last_attempt: { outcome: 'failed' } });
    clock.advance(999); expect(checks).toHaveLength(1);
    clock.advance(1); expect(checks).toHaveLength(2);
    expect(owner.status().state).toBe('checking');
  });

  it('discards elapsed wait on pause and cancels an owned check without overlap', async () => {
    const { clock, checks, owner } = fixture();
    owner.runtimeStatusChanged('running'); clock.advance(800);
    owner.runtimeStatusChanged('paused'); owner.runtimeStatusChanged('running');
    clock.advance(999); expect(checks).toHaveLength(0);
    clock.advance(1); owner.runtimeStatusChanged('paused');
    expect(checks[0]!.cancelled).toBe(true);
    owner.runtimeStatusChanged('running'); clock.advance(5000);
    expect(checks).toHaveLength(1);
    checks[0]!.resolve('cancelled'); await Promise.resolve();
    expect(owner.status()).toMatchObject({ state: 'waiting', remaining_wait_ms: 1000 });
  });

  it('keeps disabled status epoch-local and never creates a check', () => {
    const { clock, checks, owner } = fixture({ enabled: false });
    owner.runtimeStatusChanged('running'); clock.advance(10000);
    expect(checks).toHaveLength(0);
    expect(owner.status()).toMatchObject({ state: 'unavailable', eligibility_reason: 'disabled', last_attempt: null, last_successful_at: null, remaining_wait_ms: null });
  });

  it('dispatches unexpected owner failure without recording or rearming', async () => {
    const { clock, checks, failures, owner } = fixture();
    owner.runtimeStatusChanged('running'); clock.advance(1000);
    const failure = new Error('owner invariant'); checks[0]!.reject(failure);
    await Promise.resolve(); await Promise.resolve();
    expect(failures).toEqual([failure]);
    expect(owner.status()).toMatchObject({ state: 'unavailable', eligible: false, eligibility_reason: 'application_closing', last_attempt: null, last_successful_at: null, remaining_wait_ms: null });
    clock.advance(10000); expect(owner.status().last_attempt).toBeNull();
  });

  it('dispatches synchronous check-construction failure through the same terminal owner', () => {
    const clock = new Clock(); const failure = new Error('construction invariant'); const failures: unknown[] = [];
    const owner = new ProjectOversight({ enabled: true, intervalMs: 1000, agentName: 'oversight', sessionId: 'agent:oversight:global', serviceEpoch: clock.wall, clock,
      changed() {}, onOwnerFailure(error) { failures.push(error); }, createCheck() { throw failure; } });
    owner.runtimeStatusChanged('running'); clock.advance(1000);
    expect(failures).toEqual([failure]);
    expect(owner.status()).toMatchObject({ state: 'unavailable', eligible: false, eligibility_reason: 'application_closing', last_attempt: null, remaining_wait_ms: null });
  });

  it('chunks durations above the Node timeout ceiling without changing the monotonic deadline', () => {
    const interval = 2_147_483_647 + 250;
    const { clock, checks, owner } = fixture({ interval });
    owner.runtimeStatusChanged('running');
    expect(owner.status().remaining_wait_ms).toBe(interval);
    expect([...clock.timers.values()].map(({ delay }) => delay)).toEqual([2_147_483_647]);
    clock.advance(2_147_483_647); expect(checks).toHaveLength(0);
    expect(owner.status().remaining_wait_ms).toBe(250);
    expect([...clock.timers.values()].map(({ delay }) => delay)).toEqual([250]);
    clock.advance(249); expect(checks).toHaveLength(0);
    clock.advance(1); expect(checks).toHaveLength(1);
  });

  it('reacts only to actual status changes and preserves the service epoch', () => {
    const { clock, changed, owner } = fixture();
    owner.runtimeStatusChanged('starting'); owner.runtimeStatusChanged('running');
    const timers = [...clock.timers]; const changes = changed.mock.calls.length;
    owner.runtimeStatusChanged('running');
    expect([...clock.timers]).toEqual(timers); expect(changed).toHaveBeenCalledTimes(changes);
    expect(owner.status()).toMatchObject({ service_epoch: clock.wall, state: 'waiting', eligible: true, eligibility_reason: null, remaining_wait_ms: 1000 });
    owner.runtimeStatusChanged('pausing');
    expect(owner.status()).toMatchObject({ state: 'unavailable', eligible: false, eligibility_reason: 'pausing', remaining_wait_ms: null });
    owner.runtimeStatusChanged('paused'); owner.runtimeStatusChanged('running');
    expect(owner.status().remaining_wait_ms).toBe(1000);
    owner.closeAdmission();
    expect(owner.status()).toMatchObject({ state: 'unavailable', eligible: false, eligibility_reason: 'application_closing', remaining_wait_ms: null });
  });

  it('samples only the monotonic deadline across wall jumps, including deferred callback entry', async () => {
    const interval = 7_200_000;
    const { clock, checks, changed, owner } = fixture({ interval });
    owner.runtimeStatusChanged('running'); clock.advance(interval - 542_000.5);
    const timers = [...clock.timers]; const changes = changed.mock.calls.length;
    clock.adjustWall(3 * 3_600_000);
    expect(owner.status().remaining_wait_ms).toBe(542_000.5);
    expect(owner.status().remaining_wait_ms).toBe(542_000.5);
    expect([...clock.timers]).toEqual(timers); expect(changed).toHaveBeenCalledTimes(changes);
    expect(checks).toHaveLength(0);
    const timestamp = clock.wallNow();
    const component = { state: 'available', source: 'health-check', checkedAt: timestamp };
    const response = parseOperatorResponse('runtime.status', 200, {
      runtime: 'running', currentCardId: null, started_at: timestamp, pid: 1,
      actorRuntime: { pauseMode: 'running', cards: [] }, restart_server_available: false,
      oversight: owner.status(), serverAvailability: { generatedAt: timestamp, components: {
        api: component, runtime: { ...component, source: 'runtime-application' }, mcp: { ...component, source: 'mcp-manager' },
      } },
    });
    expect(response.oversight.remaining_wait_ms).toBe(542_000.5);
    clock.now += 542_000.5; // Deadline reached; deliberately defer timeout dispatch.
    expect(owner.status()).toMatchObject({ state: 'waiting', remaining_wait_ms: 0 });
    clock.now += 10; expect(owner.status().remaining_wait_ms).toBe(0);
    expect(checks).toHaveLength(0);
    clock.dispatch(); expect(checks).toHaveLength(1);
    expect(owner.status()).toMatchObject({ state: 'checking', remaining_wait_ms: null });
    checks[0]!.resolve('succeeded'); await Promise.resolve();
    expect(owner.status()).toMatchObject({ state: 'waiting', remaining_wait_ms: interval, last_successful_at: clock.wallNow() });
  });
});
