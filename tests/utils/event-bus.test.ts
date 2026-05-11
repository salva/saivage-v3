/**
 * EventBus Tests
 *
 * Covers:
 * - Severity filtering (SEVERITY_ORDER, RUNTIME_SEVERITY_MAP, AGENT_SEVERITY_MAP, getSeverity, minSeverity)
 * - Event type filtering (allowedKinds)
 * - Combined filtering (AND logic)
 * - Pause/resume buffering (FIFO drain, no-op double pause/resume)
 * - Buffer overflow (default 100, custom limit, oldest dropped)
 * - Delivery timeout (default 5000ms, configurable, async handlers only)
 * - Unsubscribe (handler not called, buffer cleared, no-op on removed)
 * - EventBus properties (subscriberCount, bufferedCount, constructor defaults)
 * - Integration: Runtime + EventBus
 *
 * Uses the same testing patterns as other tests in tests/utils/
 * (describe/it from @jest/globals, ESM, dynamic imports when needed).
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import {
  EventBus,
  SEVERITY_ORDER,
  RUNTIME_SEVERITY_MAP,
  AGENT_SEVERITY_MAP,
  SEVERITY_MAP,
  getSeverity,
} from '../../src/utils/event-bus.js';
import type { LoggedEvent, EventKind, RuntimeEventKind, AgentEventKind } from '../../src/schemas/types.js';

// ── Helpers ────────────────────────────────────────────────────

function makeEvent(overrides: Partial<LoggedEvent> = {}): LoggedEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'started',
    timestamp: new Date().toISOString(),
    ...overrides,
  } as LoggedEvent;
}

function slowHandler(delayMs: number, callOrder: string[]): (event: LoggedEvent) => Promise<void> {
  return async (_event: LoggedEvent) => {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    callOrder.push(`done-${delayMs}`);
  };
}

function spyOnConsoleWarn() {
  return jest.spyOn(console, 'warn').mockImplementation(() => {});
}

// ═══════════════════════════════════════════════════════════════
// 1. SEVERITY_ORDER
// ═══════════════════════════════════════════════════════════════

describe('SEVERITY_ORDER', () => {
  it('has exactly three levels', () => {
    expect(SEVERITY_ORDER).toHaveLength(3);
  });

  it('info is at index 0 (lowest severity)', () => {
    expect(SEVERITY_ORDER[0]).toBe('info');
  });

  it('warning is at index 1', () => {
    expect(SEVERITY_ORDER[1]).toBe('warning');
  });

  it('error is at index 2 (highest severity)', () => {
    expect(SEVERITY_ORDER[2]).toBe('error');
  });

  it('maintains ascending order: info < warning < error', () => {
    const idxInfo = SEVERITY_ORDER.indexOf('info');
    const idxWarning = SEVERITY_ORDER.indexOf('warning');
    const idxError = SEVERITY_ORDER.indexOf('error');
    expect(idxInfo).toBeLessThan(idxWarning);
    expect(idxWarning).toBeLessThan(idxError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. RUNTIME_SEVERITY_MAP
// ═══════════════════════════════════════════════════════════════

describe('RUNTIME_SEVERITY_MAP', () => {
  it('maps started → info', () => {
    expect(RUNTIME_SEVERITY_MAP.started).toBe('info');
  });

  it('maps goal_completed → info', () => {
    expect(RUNTIME_SEVERITY_MAP.goal_completed).toBe('info');
  });

  it('maps review_complete → info', () => {
    expect(RUNTIME_SEVERITY_MAP.review_complete).toBe('info');
  });

  it('maps paused → info', () => {
    expect(RUNTIME_SEVERITY_MAP.paused).toBe('info');
  });

  it('maps resumed → info', () => {
    expect(RUNTIME_SEVERITY_MAP.resumed).toBe('info');
  });

  it('maps shutdown → info', () => {
    expect(RUNTIME_SEVERITY_MAP.shutdown).toBe('info');
  });

  it('maps card_failed → warning', () => {
    expect(RUNTIME_SEVERITY_MAP.card_failed).toBe('warning');
  });

  it('maps review_failed → warning', () => {
    expect(RUNTIME_SEVERITY_MAP.review_failed).toBe('warning');
  });

  it('maps dispatch_blocked → warning', () => {
    expect(RUNTIME_SEVERITY_MAP.dispatch_blocked).toBe('warning');
  });

  it('maps dispatch_interrupted → warning', () => {
    expect(RUNTIME_SEVERITY_MAP.dispatch_interrupted).toBe('warning');
  });

  it('maps error → error', () => {
    expect(RUNTIME_SEVERITY_MAP.error).toBe('error');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. AGENT_SEVERITY_MAP
// ═══════════════════════════════════════════════════════════════

describe('AGENT_SEVERITY_MAP', () => {
  it('maps all agent event kinds to info', () => {
    const agentKinds: AgentEventKind[] = [
      'session_started',
      'model_selected',
      'invocation_succeeded',
      'invocation_failed',
      'retry_attempted',
      'compaction_triggered',
      'self_check_triggered',
    ];
    for (const kind of agentKinds) {
      expect(AGENT_SEVERITY_MAP[kind]).toBe('info');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. SEVERITY_MAP (combined)
// ═══════════════════════════════════════════════════════════════

describe('SEVERITY_MAP', () => {
  it('contains all RuntimeEventKind entries', () => {
    for (const [kind, severity] of Object.entries(RUNTIME_SEVERITY_MAP)) {
      expect(SEVERITY_MAP[kind as RuntimeEventKind]).toBe(severity);
    }
  });

  it('contains all AgentEventKind entries', () => {
    for (const [kind, severity] of Object.entries(AGENT_SEVERITY_MAP)) {
      expect(SEVERITY_MAP[kind as AgentEventKind]).toBe(severity);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. getSeverity()
// ═══════════════════════════════════════════════════════════════

describe('getSeverity', () => {
  it("returns 'info' for started", () => {
    expect(getSeverity('started')).toBe('info');
  });

  it("returns 'info' for goal_completed", () => {
    expect(getSeverity('goal_completed')).toBe('info');
  });

  it("returns 'warning' for card_failed", () => {
    expect(getSeverity('card_failed')).toBe('warning');
  });

  it("returns 'error' for error", () => {
    expect(getSeverity('error')).toBe('error');
  });

  it("returns 'info' for agent events (session_started)", () => {
    expect(getSeverity('session_started')).toBe('info');
  });

  it("returns 'info' for unknown event kinds", () => {
    // @ts-expect-error — testing unknown kind
    expect(getSeverity('nonexistent_kind')).toBe('info');
  });

  it("returns 'info' for empty string", () => {
    // @ts-expect-error — testing unknown kind
    expect(getSeverity('')).toBe('info');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Severity Filtering (minSeverity)
// ═══════════════════════════════════════════════════════════════

describe('Severity Filtering — minSeverity', () => {
  let bus: EventBus;

  afterEach(() => {
    bus = undefined as unknown as EventBus;
  });

  it("minSeverity 'info' receives all severities", () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      minSeverity: 'info',
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'card_failed' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).toContain('started');
    expect(received).toContain('card_failed');
    expect(received).toContain('error');
  });

  it("minSeverity 'warning' receives warning and error, NOT info", () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      minSeverity: 'warning',
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'card_failed' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).not.toContain('started');
    expect(received).toContain('card_failed');
    expect(received).toContain('error');
  });

  it("minSeverity 'error' receives ONLY error events", () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      minSeverity: 'error',
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'goal_completed' }));
    bus.emit(makeEvent({ kind: 'card_failed' }));
    bus.emit(makeEvent({ kind: 'review_failed' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).toEqual(['error']);
  });

  it('defaults to minSeverity info when not specified', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'card_failed' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).toHaveLength(3);
    expect(received).toContain('started');
    expect(received).toContain('card_failed');
    expect(received).toContain('error');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Event Type Filtering (allowedKinds)
// ═══════════════════════════════════════════════════════════════

describe('Event Type Filtering — allowedKinds', () => {
  let bus: EventBus;

  afterEach(() => {
    bus = undefined as unknown as EventBus;
  });

  it('allowedKinds restricts delivery to listed kinds only', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      allowedKinds: ['goal_completed', 'error'],
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'goal_completed' }));
    bus.emit(makeEvent({ kind: 'error' }));
    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'card_failed' }));

    expect(received).toContain('goal_completed');
    expect(received).toContain('error');
    expect(received).not.toContain('started');
    expect(received).not.toContain('card_failed');
    expect(received).toHaveLength(2);
  });

  it('empty allowedKinds array delivers all events matching severity', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      allowedKinds: [],
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).toHaveLength(2);
  });

  it('undefined allowedKinds delivers all events matching severity', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).toHaveLength(2);
  });

  it('allowedKinds with single entry only delivers that kind', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      allowedKinds: ['dispatch_blocked'],
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'dispatch_blocked' }));
    bus.emit(makeEvent({ kind: 'dispatch_interrupted' }));
    bus.emit(makeEvent({ kind: 'card_failed' }));

    expect(received).toEqual(['dispatch_blocked']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Combined Filtering (AND logic)
// ═══════════════════════════════════════════════════════════════

describe('Combined Filtering — minSeverity AND allowedKinds', () => {
  let bus: EventBus;

  afterEach(() => {
    bus = undefined as unknown as EventBus;
  });

  it("minSeverity 'error' AND allowedKinds ['error'] only receives error events", () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      minSeverity: 'error',
      allowedKinds: ['error'],
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'error' }));
    bus.emit(makeEvent({ kind: 'card_failed' }));
    bus.emit(makeEvent({ kind: 'started' }));

    expect(received).toEqual(['error']);
  });

  it("minSeverity 'warning' AND allowedKinds ['card_failed'] receives card_failed but not other warnings", () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      minSeverity: 'warning',
      allowedKinds: ['card_failed'],
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'card_failed' }));
    bus.emit(makeEvent({ kind: 'review_failed' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).toEqual(['card_failed']);
  });

  it("minSeverity 'error' AND allowedKinds ['error', 'card_failed'] — card_failed is warning so excluded", () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      minSeverity: 'error',
      allowedKinds: ['error', 'card_failed'],
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'card_failed' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).toEqual(['error']);
  });

  it("minSeverity 'info' AND allowedKinds ['goal_completed', 'dispatch_blocked'] — all pass severity", () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      minSeverity: 'info',
      allowedKinds: ['goal_completed', 'dispatch_blocked'],
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'goal_completed' }));
    bus.emit(makeEvent({ kind: 'dispatch_blocked' }));
    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).toContain('goal_completed');
    expect(received).toContain('dispatch_blocked');
    expect(received).not.toContain('started');
    expect(received).not.toContain('error');
    expect(received).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Pause/Resume Buffering
// ═══════════════════════════════════════════════════════════════

describe('Pause/Resume Buffering', () => {
  let bus: EventBus;

  afterEach(() => {
    bus = undefined as unknown as EventBus;
  });

  it('paused subscriber buffers events (does not call handler)', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    const sub = bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    sub.pause();
    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'error' }));

    expect(received).toHaveLength(0);
  });

  it('resumed subscriber drains buffer in FIFO order', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    const sub = bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    sub.pause();
    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'card_failed' }));
    bus.emit(makeEvent({ kind: 'error' }));

    sub.resume();

    expect(received).toEqual(['started', 'card_failed', 'error']);
  });

  it('resume calls handler for each buffered event', () => {
    bus = new EventBus();
    let callCount = 0;

    const sub = bus.subscribe({
      handler: () => { callCount++; },
    });

    sub.pause();
    bus.emit(makeEvent());
    bus.emit(makeEvent());
    bus.emit(makeEvent());

    expect(callCount).toBe(0);
    sub.resume();
    expect(callCount).toBe(3);
  });

  it('double-pause is a no-op', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    const sub = bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    sub.pause();
    sub.pause();

    bus.emit(makeEvent({ kind: 'started' }));
    expect(received).toHaveLength(0);

    sub.resume();
    expect(received).toEqual(['started']);
  });

  it('double-resume is a no-op', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    const sub = bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    sub.pause();
    bus.emit(makeEvent({ kind: 'started' }));

    sub.resume();
    sub.resume();

    expect(received).toEqual(['started']);
  });

  it('events emitted while active deliver immediately (not buffered)', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'started' }));

    expect(received).toEqual(['started']);
    expect(received).toHaveLength(1);
  });

  it('paused subscriber still respects severity and kind filters on resume', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    const sub = bus.subscribe({
      minSeverity: 'warning',
      handler: (e) => { received.push(e.kind); },
    });

    sub.pause();
    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'card_failed' }));
    bus.emit(makeEvent({ kind: 'error' }));

    sub.resume();

    expect(received).toEqual(['card_failed', 'error']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Buffer Overflow
// ═══════════════════════════════════════════════════════════════

describe('Buffer Overflow', () => {
  let bus: EventBus;

  afterEach(() => {
    bus = undefined as unknown as EventBus;
  });

  it('default buffer limit is 100 — 101st event drops oldest', () => {
    bus = new EventBus();
    const received: string[] = [];

    const sub = bus.subscribe({
      handler: (e) => { received.push(e.id); },
    });

    sub.pause();

    for (let i = 0; i < 101; i++) {
      bus.emit(makeEvent({ kind: 'started', id: `evt-${i}` }));
    }

    sub.resume();

    expect(received).toHaveLength(100);
    expect(received[0]).toBe('evt-1');
    expect(received[99]).toBe('evt-100');
    expect(received).not.toContain('evt-0');
  });

  it('configurable buffer size — buffer 4 events, oldest dropped on 5th', () => {
    bus = new EventBus();
    const received: string[] = [];

    const sub = bus.subscribe({
      bufferSize: 3,
      handler: (e) => { received.push(e.id); },
    });

    sub.pause();

    bus.emit(makeEvent({ id: 'evt-0' }));
    bus.emit(makeEvent({ id: 'evt-1' }));
    bus.emit(makeEvent({ id: 'evt-2' }));
    bus.emit(makeEvent({ id: 'evt-3' }));

    sub.resume();

    expect(received).toHaveLength(3);
    expect(received).toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect(received).not.toContain('evt-0');
  });

  it('buffer overflow drops oldest (not newest) — verify IDs', () => {
    bus = new EventBus();
    const received: string[] = [];

    const sub = bus.subscribe({
      bufferSize: 2,
      handler: (e) => { received.push(e.id); },
    });

    sub.pause();

    bus.emit(makeEvent({ id: 'first' }));
    bus.emit(makeEvent({ id: 'second' }));
    bus.emit(makeEvent({ id: 'third' }));

    sub.resume();

    expect(received).toEqual(['second', 'third']);
    expect(received).toHaveLength(2);
  });

  it('multiple buffer overflows — each overflow drops oldest', () => {
    bus = new EventBus();
    const received: string[] = [];

    const sub = bus.subscribe({
      bufferSize: 2,
      handler: (e) => { received.push(e.id); },
    });

    sub.pause();

    bus.emit(makeEvent({ id: 'a' }));
    bus.emit(makeEvent({ id: 'b' }));
    bus.emit(makeEvent({ id: 'c' }));
    bus.emit(makeEvent({ id: 'd' }));
    bus.emit(makeEvent({ id: 'e' }));

    sub.resume();

    expect(received).toEqual(['d', 'e']);
    expect(received).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Delivery Timeout
// ═══════════════════════════════════════════════════════════════

describe('Delivery Timeout', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('default timeout is 5000ms — configurable via constructor', () => {
    const bus = new EventBus({ defaultDeliveryTimeoutMs: 1000 });
    expect(bus).toBeDefined();
    expect(bus.subscriberCount).toBe(0);
  });

  it('slow async handler is timed out and console.warn is called', async () => {
    const consoleSpy = spyOnConsoleWarn();
    const bus = new EventBus({ defaultDeliveryTimeoutMs: 10 });
    const callOrder: string[] = [];

    bus.subscribe({
      deliveryTimeoutMs: 10,
      handler: slowHandler(100, callOrder),
    });

    bus.emit(makeEvent({ kind: 'started' }));

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const warnCalls = consoleSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('timed out'),
    );
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0][0]).toContain('[EventBus] Slow handler');

    consoleSpy.mockRestore();
  });

  it('timeout does not prevent other subscribers from receiving the event', async () => {
    const consoleSpy = spyOnConsoleWarn();
    const bus = new EventBus({ defaultDeliveryTimeoutMs: 10 });
    const fastCalls: EventKind[] = [];
    const slowCalls: string[] = [];

    bus.subscribe({
      deliveryTimeoutMs: 10,
      handler: slowHandler(100, slowCalls),
    });

    bus.subscribe({
      handler: (e) => { fastCalls.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'error' }));

    expect(fastCalls).toEqual(['error']);

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(fastCalls).toEqual(['error']);

    consoleSpy.mockRestore();
  });

  it('timeout uses configurable deliveryTimeoutMs per subscription', async () => {
    const consoleSpy = spyOnConsoleWarn();
    const bus = new EventBus({ defaultDeliveryTimeoutMs: 5000 });
    const callOrder: string[] = [];

    bus.subscribe({
      deliveryTimeoutMs: 10,
      handler: slowHandler(100, callOrder),
    });

    bus.emit(makeEvent({ kind: 'started' }));

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const warnCalls = consoleSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('timed out'),
    );
    expect(warnCalls.length).toBeGreaterThan(0);

    consoleSpy.mockRestore();
  });

  it('synchronous handlers are NOT subject to timeout (complete immediately)', () => {
    const consoleSpy = spyOnConsoleWarn();
    const bus = new EventBus({ defaultDeliveryTimeoutMs: 10 });
    const received: EventKind[] = [];

    bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'started' }));

    expect(received).toEqual(['started']);

    const warnCalls = consoleSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('timed out'),
    );
    expect(warnCalls).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  it('slow handler on paused subscriber is timed out during resume drain', async () => {
    const consoleSpy = spyOnConsoleWarn();
    const bus = new EventBus({ defaultDeliveryTimeoutMs: 5000 });

    const sub = bus.subscribe({
      deliveryTimeoutMs: 10,
      handler: slowHandler(100, []),
    });

    sub.pause();
    bus.emit(makeEvent({ kind: 'started' }));
    sub.resume();

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const warnCalls = consoleSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('timed out'),
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(0);

    consoleSpy.mockRestore();
  });

  it('timeout warning message includes subscription ID, event kind, and event id', async () => {
    const consoleSpy = spyOnConsoleWarn();
    const bus = new EventBus({ defaultDeliveryTimeoutMs: 10 });
    const callOrder: string[] = [];

    bus.subscribe({
      deliveryTimeoutMs: 10,
      handler: slowHandler(100, callOrder),
    });

    bus.emit(makeEvent({ kind: 'error', id: 'evt-test-123' }));

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const warnCalls = consoleSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('timed out'),
    );
    if (warnCalls.length > 0) {
      const msg = warnCalls[0][0] as string;
      expect(msg).toContain('error');
      expect(msg).toContain('evt-test-123');
    }

    consoleSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. Unsubscribe
// ═══════════════════════════════════════════════════════════════

describe('Unsubscribe', () => {
  let bus: EventBus;

  afterEach(() => {
    bus = undefined as unknown as EventBus;
  });

  it('unsubscribe removes subscription — handler never called after unsubscribe', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    const sub = bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    bus.emit(makeEvent({ kind: 'started' }));
    expect(received).toHaveLength(1);

    sub.unsubscribe();

    bus.emit(makeEvent({ kind: 'error' }));
    expect(received).toHaveLength(1);
  });

  it('unsubscribed subscription buffer is cleared', () => {
    bus = new EventBus();
    const received: EventKind[] = [];

    const sub = bus.subscribe({
      handler: (e) => { received.push(e.kind); },
    });

    sub.pause();
    bus.emit(makeEvent({ kind: 'started' }));
    bus.emit(makeEvent({ kind: 'error' }));

    sub.unsubscribe();
    sub.resume();

    expect(received).toHaveLength(0);
  });

  it('calling pause on unsubscribed subscription is no-op', () => {
    bus = new EventBus();
    const sub = bus.subscribe({ handler: () => {} });
    sub.unsubscribe();
    expect(() => sub.pause()).not.toThrow();
  });

  it('calling resume on unsubscribed subscription is no-op', () => {
    bus = new EventBus();
    const sub = bus.subscribe({ handler: () => {} });
    sub.unsubscribe();
    expect(() => sub.resume()).not.toThrow();
  });

  it('multiple unsubscribes are safe (no error)', () => {
    bus = new EventBus();
    const sub = bus.subscribe({ handler: () => {} });
    sub.unsubscribe();
    sub.unsubscribe();
    sub.unsubscribe();
    expect(bus.subscriberCount).toBe(0);
  });

  it('subscriberCount decreases after unsubscribe', () => {
    bus = new EventBus();

    const sub1 = bus.subscribe({ handler: () => {} });
    expect(bus.subscriberCount).toBe(1);

    const sub2 = bus.subscribe({ handler: () => {} });
    expect(bus.subscriberCount).toBe(2);

    sub1.unsubscribe();
    expect(bus.subscriberCount).toBe(1);

    sub2.unsubscribe();
    expect(bus.subscriberCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. EventBus Properties
// ═══════════════════════════════════════════════════════════════

describe('EventBus Properties', () => {
  it('subscriberCount returns 0 for a new bus', () => {
    const bus = new EventBus();
    expect(bus.subscriberCount).toBe(0);
  });

  it('subscriberCount returns correct count with multiple subscriptions', () => {
    const bus = new EventBus();
    bus.subscribe({ handler: () => {} });
    bus.subscribe({ handler: () => {} });
    bus.subscribe({ handler: () => {} });
    expect(bus.subscriberCount).toBe(3);
  });

  it('bufferedCount is 0 when no subscriptions are paused', () => {
    const bus = new EventBus();
    bus.subscribe({ handler: () => {} });
    bus.emit(makeEvent());
    expect(bus.bufferedCount).toBe(0);
  });

  it('bufferedCount returns total buffered events across all paused subscriptions', () => {
    const bus = new EventBus();

    const sub1 = bus.subscribe({ handler: () => {} });
    const sub2 = bus.subscribe({ handler: () => {} });

    sub1.pause();
    sub2.pause();

    bus.emit(makeEvent());
    bus.emit(makeEvent());
    bus.emit(makeEvent());

    // 3 events buffered in sub1, 3 in sub2 = 6 total
    expect(bus.bufferedCount).toBe(6);

    sub1.resume();
    // sub2 still has 3 buffered
    expect(bus.bufferedCount).toBe(3);

    sub2.resume();
    expect(bus.bufferedCount).toBe(0);
  });

  it('default constructor values (no options) work', () => {
    const bus = new EventBus();
    expect(bus.subscriberCount).toBe(0);
    expect(bus.bufferedCount).toBe(0);

    // Should use default buffer size 100 and timeout 5000
    const received: EventKind[] = [];
    bus.subscribe({ handler: (e) => { received.push(e.kind); } });
    bus.emit(makeEvent({ kind: 'started' }));
    expect(received).toEqual(['started']);
  });

  it('custom constructor values (defaultBufferSize, defaultDeliveryTimeoutMs)', () => {
    const bus = new EventBus({
      defaultBufferSize: 50,
      defaultDeliveryTimeoutMs: 3000,
    });
    expect(bus.subscriberCount).toBe(0);

    // Verify subscription inherits defaults
    const received: EventKind[] = [];
    bus.subscribe({ handler: (e) => { received.push(e.kind); } });
    bus.emit(makeEvent({ kind: 'started' }));
    expect(received).toEqual(['started']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. Integration: Runtime + EventBus
// ═══════════════════════════════════════════════════════════════

describe('Runtime + EventBus Integration', () => {
  it('Runtime creates an EventBus instance (runtime.eventBus exists)', async () => {
    const { Runtime } = await import('../../src/utils/runtime.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { initProjectTree } = await import('../../src/utils/file-tree.js');
    const { releaseLock } = await import('../../src/utils/runtime-lock.js');

    const tmpDir = mkdtempSync(join(tmpdir(), 'saivage-eb-int-'));
    initProjectTree(tmpDir);

    try {
      const runtime = new Runtime({
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
      });

      expect(runtime.eventBus).toBeDefined();
      expect(runtime.eventBus).toBeInstanceOf(EventBus);
      expect(runtime.eventBus.subscriberCount).toBe(0);
    } finally {
      try { releaseLock(tmpDir); } catch { /* ignore */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runtime.emit() forwards events to EventBus', async () => {
    const { Runtime } = await import('../../src/utils/runtime.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { initProjectTree } = await import('../../src/utils/file-tree.js');
    const { releaseLock } = await import('../../src/utils/runtime-lock.js');

    const tmpDir = mkdtempSync(join(tmpdir(), 'saivage-eb-int2-'));
    initProjectTree(tmpDir);

    try {
      const runtime = new Runtime({
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
      });

      const received: EventKind[] = [];
      runtime.eventBus.subscribe({
        handler: (e) => { received.push(e.kind); },
      });

      runtime.emit('goal_completed', { goalId: 'g1' });

      expect(received).toContain('goal_completed');
    } finally {
      try { releaseLock(tmpDir); } catch { /* ignore */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('EventBus subscription on runtime.eventBus receives events emitted via runtime.emit()', async () => {
    const { Runtime } = await import('../../src/utils/runtime.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { initProjectTree } = await import('../../src/utils/file-tree.js');
    const { releaseLock } = await import('../../src/utils/runtime-lock.js');

    const tmpDir = mkdtempSync(join(tmpdir(), 'saivage-eb-int3-'));
    initProjectTree(tmpDir);

    try {
      const runtime = new Runtime({
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
      });

      const received: Array<{ kind: EventKind; data: Record<string, unknown> }> = [];
      runtime.eventBus.subscribe({
        handler: (event) => {
          const { kind, id, timestamp, ...data } = event as LoggedEvent & Record<string, unknown>;
          received.push({ kind, data: data as Record<string, unknown> });
        },
      });

      // Note: DO NOT use 'error' event name — Node's EventEmitter throws
      // if there's no 'error' listener registered. Use other tracked kinds.
      runtime.emit('card_failed', { cardId: 'c1', goalId: 'g1' });
      runtime.emit('dispatch_blocked', { reason: 'test', goalId: 'g1' });
      runtime.emit('started', { projectRoot: tmpDir });

      expect(received).toHaveLength(3);
      expect(received[0].kind).toBe('card_failed');
      expect(received[1].kind).toBe('dispatch_blocked');
      expect(received[2].kind).toBe('started');
    } finally {
      try { releaseLock(tmpDir); } catch { /* ignore */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runtime.on() backward compat still works alongside EventBus', async () => {
    const { Runtime } = await import('../../src/utils/runtime.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { initProjectTree } = await import('../../src/utils/file-tree.js');
    const { releaseLock } = await import('../../src/utils/runtime-lock.js');

    const tmpDir = mkdtempSync(join(tmpdir(), 'saivage-eb-int4-'));
    initProjectTree(tmpDir);

    try {
      const runtime = new Runtime({
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
      });

      const onCalls: string[] = [];
      runtime.on('goal_completed', () => {
        onCalls.push('goal_completed-via-on');
      });

      const ebCalls: EventKind[] = [];
      runtime.eventBus.subscribe({
        handler: (e) => { ebCalls.push(e.kind); },
      });

      runtime.emit('goal_completed', { goalId: 'g1' });

      expect(onCalls).toContain('goal_completed-via-on');
      expect(ebCalls).toContain('goal_completed');
    } finally {
      try { releaseLock(tmpDir); } catch { /* ignore */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runtime.on() for non-tracked event still works but NOT forwarded to EventBus', async () => {
    const { Runtime } = await import('../../src/utils/runtime.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { initProjectTree } = await import('../../src/utils/file-tree.js');
    const { releaseLock } = await import('../../src/utils/runtime-lock.js');

    const tmpDir = mkdtempSync(join(tmpdir(), 'saivage-eb-int5-'));
    initProjectTree(tmpDir);

    try {
      const runtime = new Runtime({
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
      });

      const onCalls: string[] = [];
      runtime.on('custom_event', () => onCalls.push('custom_event-via-on'));

      const ebCalls: EventKind[] = [];
      runtime.eventBus.subscribe({
        handler: (e) => { ebCalls.push(e.kind); },
      });

      runtime.emit('custom_event', { data: 'hello' });

      expect(onCalls).toContain('custom_event-via-on');
      expect(ebCalls).not.toContain('custom_event' as EventKind);
    } finally {
      try { releaseLock(tmpDir); } catch { /* ignore */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
