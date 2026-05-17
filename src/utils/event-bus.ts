/**
 * In-process event bus for runtime event distribution.
 */

import type {
  EventKind,
  LoggedEvent,
  RuntimeEventKind,
  AgentEventKind,
} from '../schemas/types.js';

export type SeverityLevel = 'info' | 'warning' | 'error';
export const SEVERITY_ORDER: SeverityLevel[] = ['info', 'warning', 'error'];

export const RUNTIME_SEVERITY_MAP: Record<RuntimeEventKind, SeverityLevel> = {
  goal_report_rejected: 'warning',
  started: 'info',
  goal_completed: 'info',
  goal_failed: 'error',
  review_complete: 'info',
  review_failed: 'warning',
  shutdown: 'info',
  paused: 'info',
  resumed: 'info',
  card_failed: 'warning',
  escalation: 'warning',
  plan_updated: 'info',
  dispatch_blocked: 'warning',
  dispatch_interrupted: 'warning',
  dispatch_held_for_notification: 'warning',
  error: 'error',
  stuck_supervisor_started: 'info',
  stuck_supervisor_stopped: 'info',
  stuck_verdict: 'warning',
  abort_target_selected: 'warning',
  force_cancel_sent: 'error',
  project_run_completed: 'info',
};

export const AGENT_SEVERITY_MAP: Record<AgentEventKind, SeverityLevel> = {
  session_started: 'info',
  model_selected: 'info',
  invocation_succeeded: 'info',
  invocation_failed: 'info',
  retry_attempted: 'info',
  compaction_triggered: 'info',
  self_check_triggered: 'info',
  session_cancelled: 'warning',
  session_force_cancelled: 'error',
  mcp_tool_invocation: 'info',
};

export const SEVERITY_MAP: Record<EventKind, SeverityLevel> = {
  ...RUNTIME_SEVERITY_MAP,
  ...AGENT_SEVERITY_MAP,
};

export function getSeverity(eventKind: EventKind): SeverityLevel {
  return SEVERITY_MAP[eventKind] ?? 'info';
}

function severityToNumber(severity: SeverityLevel): number {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx >= 0 ? idx : 0;
}

export interface SubscriptionOptions {
  minSeverity?: SeverityLevel;
  allowedKinds?: EventKind[];
  handler: (event: LoggedEvent) => void | Promise<void>;
  bufferSize?: number;
  deliveryTimeoutMs?: number;
}

export interface EventBusSubscription {
  readonly id: string;
  pause(): void;
  resume(): void;
  unsubscribe(): void;
}

interface InternalSubscription {
  id: string;
  minSeverityIdx: number;
  allowedKinds: Set<EventKind> | null;
  handler: (event: LoggedEvent) => void | Promise<void>;
  bufferSize: number;
  deliveryTimeoutMs: number;
  paused: boolean;
  buffer: LoggedEvent[];
  active: boolean;
}

export class EventBus {
  private subscriptions: InternalSubscription[] = [];
  private idCounter = 0;
  private readonly defaultBufferSize: number;
  private readonly defaultDeliveryTimeoutMs: number;

  constructor(options?: { defaultBufferSize?: number; defaultDeliveryTimeoutMs?: number }) {
    this.defaultBufferSize = options?.defaultBufferSize ?? 100;
    this.defaultDeliveryTimeoutMs = options?.defaultDeliveryTimeoutMs ?? 5000;
  }

  subscribe(options: SubscriptionOptions): EventBusSubscription {
    const id = this._nextId();
    const sub: InternalSubscription = {
      id,
      minSeverityIdx: severityToNumber(options.minSeverity ?? 'info'),
      allowedKinds: options.allowedKinds?.length ? new Set(options.allowedKinds) : null,
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

  emit(event: LoggedEvent): void {
    const eventSeverityIdx = severityToNumber(getSeverity(event.kind));
    for (const sub of this.subscriptions) {
      if (!sub.active) continue;
      if (eventSeverityIdx < sub.minSeverityIdx) continue;
      if (sub.allowedKinds && !sub.allowedKinds.has(event.kind)) continue;
      if (sub.paused) {
        sub.buffer.push(event);
        while (sub.buffer.length > sub.bufferSize) sub.buffer.shift();
      } else {
        this._deliver(sub, event);
      }
    }
  }

  get subscriberCount(): number {
    return this.subscriptions.filter((s) => s.active).length;
  }

  get bufferedCount(): number {
    return this.subscriptions.reduce((sum, s) => sum + s.buffer.length, 0);
  }

  private _nextId(): string {
    this.idCounter++;
    return `eb-sub-${Date.now()}-${this.idCounter}`;
  }

  private _deliver(sub: InternalSubscription, event: LoggedEvent): void {
    const result = sub.handler(event);
    if (result && typeof (result as Promise<void>).then === 'function') {
      this._withTimeout(result as Promise<void>, sub, event);
    }
  }

  private _withTimeout(promise: Promise<void>, sub: InternalSubscription, event: LoggedEvent): void {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[EventBus] Slow handler for subscription '${sub.id}' timed out after ${sub.deliveryTimeoutMs}ms (event: ${event.kind}, id: ${event.id})`);
    }, sub.deliveryTimeoutMs);
    timer.unref();
    promise.then(() => {
      if (!timedOut) clearTimeout(timer);
    }).catch((err: unknown) => {
      if (!timedOut) {
        clearTimeout(timer);
        console.error(`[EventBus] Handler error for subscription '${sub.id}' (event: ${event.kind}, id: ${event.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private _pause(sub: InternalSubscription): void {
    if (!sub.active || sub.paused) return;
    sub.paused = true;
  }

  private _resume(sub: InternalSubscription): void {
    if (!sub.active || !sub.paused) return;
    sub.paused = false;
    const buffered = sub.buffer.splice(0);
    for (const event of buffered) this._deliver(sub, event);
  }

  private _unsubscribe(sub: InternalSubscription): void {
    if (!sub.active) return;
    sub.active = false;
    sub.buffer = [];
    const idx = this.subscriptions.indexOf(sub);
    if (idx >= 0) this.subscriptions.splice(idx, 1);
  }
}
