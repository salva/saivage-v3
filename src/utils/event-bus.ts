/**
 * In-process event bus for runtime event distribution.
 *
 * Implements the subscription features specified in 04-runtime.md §Event Bus:
 * - Severity-based filtering (info < warning < error)
 * - Event type filtering (allowedKinds)
 * - Pause/resume with configurable buffering (default 100, oldest dropped on overflow)
 * - Delivery timeout (default 5s) to prevent slow handlers from blocking the bus
 *
 * The EventBus is a standalone class — it does NOT extend Node's EventEmitter.
 * Internal subscription IDs use a counter + Date.now() pattern.
 */

import type {
  EventKind,
  LoggedEvent,
  RuntimeEventKind,
  AgentEventKind,
} from '../schemas/types.js';

// ── Severity System ────────────────────────────────────────────

/**
 * Severity levels in ascending order of importance.
 *
 * `info` (0) — normal operational events.
 * `warning` (1) — potential issues that don't block progress.
 * `error` (2) — failures that require attention.
 */
export type SeverityLevel = 'info' | 'warning' | 'error';

/**
 * Severity ordering array: lower index = lower severity.
 * Comparisons use this array's indices so that `info < warning < error`.
 */
export const SEVERITY_ORDER: SeverityLevel[] = [
  'info',
  'warning',
  'error',
];

/**
 * Map from RuntimeEventKind to its severity level.
 *
 * Grouped per the spec in 04-runtime.md §Event Bus:
 *
 * | Event type            | Severity |
 * |-----------------------|----------|
 * | `started`             | info     |
 * | `goal_completed`      | info     |
 * | `review_complete`     | info     |
 * | `paused`              | info     |
 * | `resumed`             | info     |
 * | `shutdown`            | info     |
 * | `card_failed`         | warning  |
 * | `review_failed`       | warning  |
 * | `dispatch_blocked`    | warning  |
 * | `dispatch_interrupted` | warning |
 * | `error`               | error    |
 */
export const RUNTIME_SEVERITY_MAP: Record<RuntimeEventKind, SeverityLevel> = {
  started: 'info',
  goal_completed: 'info',
  review_complete: 'info',
  review_failed: 'warning',
  shutdown: 'info',
  paused: 'info',
  resumed: 'info',
  card_failed: 'warning',
  dispatch_blocked: 'warning',
  dispatch_interrupted: 'warning',
  error: 'error',
};

/**
 * Agent event kinds mapped to their default severity level.
 *
 * All AgentEventKind events default to `'info'` severity.
 */
export const AGENT_SEVERITY_MAP: Record<AgentEventKind, SeverityLevel> = {
  session_started: 'info',
  model_selected: 'info',
  invocation_succeeded: 'info',
  invocation_failed: 'info',
  retry_attempted: 'info',
  compaction_triggered: 'info',
  self_check_triggered: 'info',
};

/**
 * Combined severity map covering every known EventKind.
 *
 * RuntimeEventKind entries use the spec-defined severities from
 * {@link RUNTIME_SEVERITY_MAP}. AgentEventKind entries default to `info`.
 * Unknown event kinds (not in this map) also default to `info` when
 * looked up via {@link getSeverity}.
 */
export const SEVERITY_MAP: Record<EventKind, SeverityLevel> = {
  ...RUNTIME_SEVERITY_MAP,
  ...AGENT_SEVERITY_MAP,
};

// ── Helpers ────────────────────────────────────────────────────

/**
 * Return the severity level for a given event kind.
 *
 * Unknown event kinds default to `info` severity.
 *
 * @param eventKind  The event kind string (e.g. 'goal_failed', 'session_started').
 * @returns The corresponding SeverityLevel, defaulting to 'info'.
 */
export function getSeverity(eventKind: EventKind): SeverityLevel {
  return SEVERITY_MAP[eventKind] ?? 'info';
}

/**
 * Convert a SeverityLevel string to its numeric index in SEVERITY_ORDER.
 *
 * @param severity  The severity level to convert.
 * @returns Numeric index (0 = info, 1 = warning, 2 = error). Returns 0 for unknown values.
 */
function severityToNumber(severity: SeverityLevel): number {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx >= 0 ? idx : 0;
}

// ── Subscription Interface ─────────────────────────────────────

/**
 * Options for creating an event bus subscription.
 */
export interface SubscriptionOptions {
  /**
   * Minimum severity to receive (inclusive).
   *
   * Events with severity below this threshold are NOT delivered.
   * Default: `'info'` (receives all events).
   */
  minSeverity?: SeverityLevel;

  /**
   * Only receive these event kinds.
   *
   * If `undefined` or empty, all event kinds that pass the severity
   * filter are delivered.
   */
  allowedKinds?: EventKind[];

  /**
   * Handler function called for each matching event.
   *
   * May be async; the bus wraps each invocation in a delivery timeout.
   * If the handler throws or rejects, the error is caught and logged —
   * it does NOT prevent other subscribers from receiving the event.
   */
  handler: (event: LoggedEvent) => void | Promise<void>;

  /**
   * Maximum number of events to buffer while the subscription is paused.
   *
   * When the buffer is full and a new event arrives, the oldest event
   * is dropped (FIFO with head eviction).
   * Default: `100`.
   */
  bufferSize?: number;

  /**
   * Maximum time (in ms) to wait for a handler to resolve.
   *
   * If the handler does not resolve/reject within this time, a warning
   * is logged and the delivery proceeds (other subscribers are unaffected).
   * Default: `5000` (5 seconds).
   */
  deliveryTimeoutMs?: number;
}

/**
 * A handle representing an active event bus subscription.
 *
 * Call `pause()` to buffer events, `resume()` to drain the buffer and
 * resume live delivery, and `unsubscribe()` to permanently stop receiving
 * events and free resources.
 */
export interface EventBusSubscription {
  /** Unique identifier for this subscription. */
  readonly id: string;

  /**
   * Pause delivery for this subscription.
   *
   * While paused, matching events are stored in a buffer (up to the
   * configured limit). Events beyond the buffer size are dropped (oldest first).
   * Calling `pause()` on an already-paused subscription is a no-op.
   */
  pause(): void;

  /**
   * Resume delivery for this subscription.
   *
   * Any buffered events are delivered in FIFO order (oldest first)
   * before live events resume. Each buffered event is delivered with
   * its own delivery timeout.
   * Calling `resume()` on an already-active subscription is a no-op.
   */
  resume(): void;

  /**
   * Permanently unsubscribe from the event bus.
   *
   * The subscription is removed, the buffer is cleared, and no further
   * events are delivered. Calling any method on a removed subscription
   * is a no-op.
   */
  unsubscribe(): void;
}

// ── Internal Subscription State ────────────────────────────────

interface InternalSubscription {
  id: string;
  minSeverityIdx: number;
  allowedKinds: Set<EventKind> | null;
  handler: (event: LoggedEvent) => void | Promise<void>;
  bufferSize: number;
  deliveryTimeoutMs: number;
  paused: boolean;
  buffer: LoggedEvent[];
  active: boolean; // false after unsubscribe
}

// ── EventBus Class ─────────────────────────────────────────────

/**
 * In-process pub/sub event bus for runtime events.
 *
 * Features:
 * - **Severity filtering**: Subscribers specify a minimum severity to receive.
 * - **Event type filtering**: Subscribers can restrict to specific event kinds.
 * - **Pause/resume with buffering**: Paused subscriptions buffer events (up to a
 *   configurable limit). On resume, buffered events are drained in FIFO order.
 * - **Delivery timeout**: Each handler invocation is wrapped in a timeout.
 *   Slow handlers are warned but do NOT block the bus or other subscribers.
 * - **Fire-and-forget emit**: `emit()` dispatches to all subscribers
 *   concurrently. It does not await handler completion.
 *
 * The EventBus is a standalone class — it does not extend Node's EventEmitter.
 *
 * @example
 * ```typescript
 * const bus = new EventBus({ defaultBufferSize: 100, defaultDeliveryTimeoutMs: 5000 });
 *
 * const sub = bus.subscribe({
 *   minSeverity: 'error',
 *   allowedKinds: ['goal_failed', 'card_failed', 'error'],
 *   handler: (event) => console.error(event.kind, event),
 * });
 *
 * bus.emit({ kind: 'goal_failed', ... }); // delivered
 *
 * sub.pause();
 * bus.emit({ kind: 'goal_failed', ... }); // buffered
 * sub.resume();  // buffered event delivered
 * sub.unsubscribe();
 * ```
 */
export class EventBus {
  private subscriptions: InternalSubscription[] = [];
  private idCounter = 0;
  private readonly defaultBufferSize: number;
  private readonly defaultDeliveryTimeoutMs: number;

  /**
   * Create a new EventBus instance.
   *
   * @param options.defaultBufferSize       Default buffer size for subscriptions that
   *                                        don't specify one. Default: `100`.
   * @param options.defaultDeliveryTimeoutMs Default delivery timeout (ms) for subscriptions
   *                                        that don't specify one. Default: `5000`.
   */
  constructor(options?: {
    defaultBufferSize?: number;
    defaultDeliveryTimeoutMs?: number;
  }) {
    this.defaultBufferSize = options?.defaultBufferSize ?? 100;
    this.defaultDeliveryTimeoutMs = options?.defaultDeliveryTimeoutMs ?? 5000;
  }

  /**
   * Create a new subscription and begin receiving matching events.
   *
   * @param options  Subscription configuration (see {@link SubscriptionOptions}).
   * @returns A handle that supports `pause()`, `resume()`, and `unsubscribe()`.
   */
  subscribe(options: SubscriptionOptions): EventBusSubscription {
    const id = this._nextId();

    const sub: InternalSubscription = {
      id,
      minSeverityIdx: severityToNumber(options.minSeverity ?? 'info'),
      allowedKinds: options.allowedKinds?.length
        ? new Set(options.allowedKinds)
        : null,
      handler: options.handler,
      bufferSize: options.bufferSize ?? this.defaultBufferSize,
      deliveryTimeoutMs: options.deliveryTimeoutMs ?? this.defaultDeliveryTimeoutMs,
      paused: false,
      buffer: [],
      active: true,
    };

    this.subscriptions.push(sub);

    return {
      id: sub.id,
      pause: () => this._pause(sub),
      resume: () => this._resume(sub),
      unsubscribe: () => this._unsubscribe(sub),
    };
  }

  /**
   * Emit an event to all active subscriptions.
   *
   * Matching is determined by severity threshold and optional event kind
   * filter. Delivery is fire-and-forget — each handler runs concurrently
   * with its own timeout wrapper.
   *
   * Paused subscriptions receive the event into their buffer.
   * Active subscriptions invoke the handler immediately.
   *
   * @param event  The event to distribute.
   */
  emit(event: LoggedEvent): void {
    const eventSeverityIdx = severityToNumber(getSeverity(event.kind));

    for (const sub of this.subscriptions) {
      if (!sub.active) continue;

      // Check severity threshold
      if (eventSeverityIdx < sub.minSeverityIdx) continue;

      // Check allowed kinds filter
      if (sub.allowedKinds && !sub.allowedKinds.has(event.kind)) continue;

      if (sub.paused) {
        // Buffer the event
        sub.buffer.push(event);
        // Drop oldest if buffer exceeds limit
        while (sub.buffer.length > sub.bufferSize) {
          sub.buffer.shift();
        }
      } else {
        // Deliver fire-and-forget
        this._deliver(sub, event);
      }
    }
  }

  /**
   * Return the number of active subscriptions.
   */
  get subscriberCount(): number {
    return this.subscriptions.filter((s) => s.active).length;
  }

  /**
   * Return the total number of events currently buffered across all
   * paused subscriptions.
   */
  get bufferedCount(): number {
    return this.subscriptions.reduce((sum, s) => sum + s.buffer.length, 0);
  }

  // ── Internal Methods ─────────────────────────────────────────

  private _nextId(): string {
    this.idCounter++;
    return `eb-sub-${Date.now()}-${this.idCounter}`;
  }

  /**
   * Deliver an event to a single subscription's handler with a timeout
   * wrapper. This is fire-and-forget — the returned promise is intentionally
   * not awaited.
   */
  private _deliver(sub: InternalSubscription, event: LoggedEvent): void {
    const result = sub.handler(event);

    // Only apply timeout if the handler returned a Promise
    if (result && typeof result.then === 'function') {
      this._withTimeout(result as Promise<void>, sub, event);
    }
    // Synchronous handlers need no timeout wrapper
  }

  /**
   * Wrap a handler promise with a delivery timeout.
   *
   * If the handler doesn't resolve/reject within the timeout, a warning
   * is logged. The timeout timer uses `unref()` so it doesn't keep the
   * Node.js process alive.
   */
  private _withTimeout(
    promise: Promise<void>,
    sub: InternalSubscription,
    event: LoggedEvent,
  ): void {
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[EventBus] Slow handler for subscription '${sub.id}' ` +
        `timed out after ${sub.deliveryTimeoutMs}ms ` +
        `(event: ${event.kind}, id: ${event.id})`,
      );
    }, sub.deliveryTimeoutMs);
    timer.unref();

    // Attach resolution to clear the timer
    promise
      .then(() => {
        if (!timedOut) clearTimeout(timer);
      })
      .catch((err: unknown) => {
        if (!timedOut) {
          clearTimeout(timer);
          console.error(
            `[EventBus] Handler error for subscription '${sub.id}' ` +
            `(event: ${event.kind}, id: ${event.id}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
  }

  /**
   * Pause a subscription. Events are buffered instead of delivered.
   * No-op if already paused or unsubscribed.
   */
  private _pause(sub: InternalSubscription): void {
    if (!sub.active || sub.paused) return;
    sub.paused = true;
  }

  /**
   * Resume a subscription. Drains the buffer in FIFO order, then
   * resumes live delivery. No-op if already active or unsubscribed.
   */
  private _resume(sub: InternalSubscription): void {
    if (!sub.active || !sub.paused) return;
    sub.paused = false;

    // Drain the buffer — deliver each event with timeout
    // We splice out all events to avoid re-entrancy issues
    const buffered = sub.buffer.splice(0);
    for (const event of buffered) {
      this._deliver(sub, event);
    }
  }

  /**
   * Unsubscribe and clean up. The subscription is removed and its
   * buffer is cleared. Subsequent calls to pause/resume/unsubscribe
   * are no-ops.
   */
  private _unsubscribe(sub: InternalSubscription): void {
    if (!sub.active) return;
    sub.active = false;
    sub.buffer = [];
    // Remove from the subscriptions list
    const idx = this.subscriptions.indexOf(sub);
    if (idx >= 0) {
      this.subscriptions.splice(idx, 1);
    }
  }
}
