import { EventRegistry, type EventKind, type EventPayload, type SeverityLevel, getEventSeverity } from './registry.js';

export { EventRegistry, getEventSeverity, type EventKind, type EventPayload, type SeverityLevel };
export const SEVERITY_ORDER: SeverityLevel[] = ['info', 'warning', 'error'];

export interface DomainEvent<K extends EventKind = EventKind> {
  id: string;
  kind: K;
  payload: EventPayload<K>;
  ts: number;
  timestamp: string;
  correlationId?: string;
}

export interface Subscription {
  readonly id: string;
  pause(): void;
  resume(): void;
  unsubscribe(): void;
}

export type EventHandler<K extends EventKind = EventKind> = (event: DomainEvent<K>) => void | Promise<void>;

export interface SubscriptionOptions<K extends EventKind = EventKind> {
  minSeverity?: SeverityLevel;
  allowedKinds?: EventKind[];
  bufferSize?: number;
  deliveryTimeoutMs?: number;
  correlationId?: string;
  propagateErrors?: boolean;
  handler: EventHandler<K>;
}

interface InternalSubscription {
  id: string;
  minSeverityIdx: number;
  allowedKinds: Set<EventKind> | null;
  handler: EventHandler;
  bufferSize: number;
  deliveryTimeoutMs: number;
  paused: boolean;
  buffer: DomainEvent[];
  active: boolean;
  propagateErrors: boolean;
}

export class BusDisposed extends Error {
  constructor() {
    super('EventBus has been disposed');
    this.name = 'BusDisposed';
  }
}

function severityToNumber(severity: SeverityLevel): number {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx >= 0 ? idx : 0;
}

function isLegacyEvent(value: unknown): value is { kind: EventKind; id?: string; timestamp?: string; correlationId?: string } & Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && 'kind' in value && typeof (value as { kind?: unknown }).kind === 'string');
}

function eventToLegacyRecord(event: DomainEvent): Record<string, unknown> {
  return {
    id: event.id,
    kind: event.kind,
    timestamp: event.timestamp,
    ...event.payload as Record<string, unknown>,
  };
}

function eventIdSuffix(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.slice(0, 8);
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

export class EventBus {
  private subscriptions: InternalSubscription[] = [];
  private idCounter = 0;
  private readonly defaultBufferSize: number;
  private readonly defaultDeliveryTimeoutMs: number;
  private disposed = false;

  constructor(options?: { defaultBufferSize?: number; defaultDeliveryTimeoutMs?: number }) {
    this.defaultBufferSize = options?.defaultBufferSize ?? 100;
    this.defaultDeliveryTimeoutMs = options?.defaultDeliveryTimeoutMs ?? 5000;
  }

  emit(event: { kind: EventKind; id?: string; timestamp?: string; correlationId?: string } & object): void;
  emit<K extends EventKind>(kind: K, payload: EventPayload<K>, options?: { correlationId?: string }): void;
  emit<K extends EventKind>(kindOrEvent: K | ({ kind: EventKind; id?: string; timestamp?: string; correlationId?: string } & object), payload?: EventPayload<K>, options?: { correlationId?: string }): void {
    if (this.disposed) throw new BusDisposed();
    const event = isLegacyEvent(kindOrEvent)
      ? this.fromLegacyRecord(kindOrEvent)
      : this.createEvent(kindOrEvent as K, payload as EventPayload<K>, options);
    const eventSeverityIdx = severityToNumber(getEventSeverity(event.kind));
    for (const sub of [...this.subscriptions]) {
      if (!sub.active) continue;
      if (eventSeverityIdx < sub.minSeverityIdx) continue;
      if (sub.allowedKinds && !sub.allowedKinds.has(event.kind)) continue;
      if (sub.paused) {
        sub.buffer.push(event);
        while (sub.buffer.length > sub.bufferSize) sub.buffer.shift();
      } else {
        this.deliver(sub, event);
      }
    }
  }

  subscribe<K extends EventKind>(kind: K, handler: EventHandler<K>, options?: Omit<SubscriptionOptions<K>, 'handler'>): Subscription;
  subscribe(options: SubscriptionOptions): Subscription;
  subscribe<K extends EventKind>(kindOrOptions: K | SubscriptionOptions, handler?: EventHandler<K>, options?: Omit<SubscriptionOptions<K>, 'handler'>): Subscription {
    if (typeof kindOrOptions === 'string') {
      return this.addSubscription(new Set<EventKind>([kindOrOptions]), handler as EventHandler, options);
    }
    return this.addSubscription(null, kindOrOptions.handler as EventHandler, kindOrOptions);
  }

  subscribeMany(kinds: EventKind[], handler: EventHandler, options?: Omit<SubscriptionOptions, 'handler'>): Subscription {
    return this.addSubscription(new Set(kinds), handler, options);
  }

  dispose(): void {
    this.disposed = true;
    for (const sub of [...this.subscriptions]) this.unsubscribe(sub);
    this.subscriptions = [];
  }

  get subscriberCount(): number {
    return this.subscriptions.filter((s) => s.active).length;
  }

  get bufferedCount(): number {
    return this.subscriptions.reduce((sum, s) => sum + s.buffer.length, 0);
  }

  private createEvent<K extends EventKind>(kind: K, payload: EventPayload<K>, options?: { correlationId?: string }): DomainEvent<K> {
    EventRegistry[kind].schema.parse(payload);
    const ts = Date.now();
    return { ...(payload as Record<string, unknown>), id: `evt-${ts}-${eventIdSuffix()}`, kind, payload, ts, timestamp: new Date(ts).toISOString(), correlationId: options?.correlationId } as DomainEvent<K>;
  }

  private fromLegacyRecord(record: { kind: EventKind; id?: string; timestamp?: string; correlationId?: string } & object): DomainEvent {
    const { kind, id, timestamp, correlationId, ...payload } = record as { kind: EventKind; id?: string; timestamp?: string; correlationId?: string } & Record<string, unknown>;
    EventRegistry[kind].schema.parse(payload);
    const ts = timestamp ? Date.parse(timestamp) : Date.now();
    return { ...payload, id: id ?? `evt-${Date.now()}-${eventIdSuffix()}`, kind, payload: payload as EventPayload<EventKind>, ts: Number.isFinite(ts) ? ts : Date.now(), timestamp: timestamp ?? new Date().toISOString(), correlationId } as DomainEvent;
  }

  private addSubscription(allowedKinds: Set<EventKind> | null, handler: EventHandler, options?: Omit<SubscriptionOptions, 'handler'>): Subscription {
    if (this.disposed) throw new BusDisposed();
    const sub: InternalSubscription = {
      id: this.nextId(),
      minSeverityIdx: severityToNumber(options?.minSeverity ?? 'info'),
      allowedKinds,
      handler,
      bufferSize: options?.bufferSize ?? this.defaultBufferSize,
      deliveryTimeoutMs: options?.deliveryTimeoutMs ?? this.defaultDeliveryTimeoutMs,
      propagateErrors: options?.propagateErrors ?? false,
      paused: false,
      buffer: [],
      active: true,
    };
    this.subscriptions.push(sub);
    return {
      id: sub.id,
      pause: () => this.pause(sub),
      resume: () => this.resume(sub),
      unsubscribe: () => this.unsubscribe(sub),
    };
  }

  private nextId(): string {
    this.idCounter++;
    return `eb-sub-${Date.now()}-${this.idCounter}`;
  }

  private deliver(sub: InternalSubscription, event: DomainEvent): void {
    try {
      const result = sub.handler(event);
      if (result && typeof (result as Promise<void>).then === 'function') {
        this.withTimeout(result as Promise<void>, sub, event);
      }
    } catch (err) {
      this.emitSubscriberError(sub, event, err, false);
      if (sub.propagateErrors) throw err;
    }
  }

  private withTimeout(promise: Promise<void>, sub: InternalSubscription, event: DomainEvent): void {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.emitSubscriberError(sub, event, new Error(`Handler timed out after ${sub.deliveryTimeoutMs}ms`), true);
    }, sub.deliveryTimeoutMs);
    timer.unref();
    promise.then(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
    }).catch((err: unknown) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        this.emitSubscriberError(sub, event, err, false);
      }
    });
  }

  private emitSubscriberError(sub: InternalSubscription, event: DomainEvent, err: unknown, timedOut: boolean): void {
    if (event.kind === 'subscriber_error' || this.disposed) return;
    const error = err instanceof Error ? err : new Error(String(err));
    this.emit('subscriber_error', {
      subscription_id: sub.id,
      source_kind: event.kind,
      error_message: error.message,
      error_name: error.name,
      timed_out: timedOut,
    });
  }

  private pause(sub: InternalSubscription): void {
    if (!sub.active || sub.paused) return;
    sub.paused = true;
  }

  private resume(sub: InternalSubscription): void {
    if (!sub.active || !sub.paused) return;
    sub.paused = false;
    const buffered = sub.buffer.splice(0);
    for (const event of buffered) this.deliver(sub, event);
  }

  private unsubscribe(sub: InternalSubscription): void {
    if (!sub.active) return;
    sub.active = false;
    sub.buffer = [];
    const idx = this.subscriptions.indexOf(sub);
    if (idx >= 0) this.subscriptions.splice(idx, 1);
  }
}

export function toLoggedEvent(event: DomainEvent): Record<string, unknown> {
  return eventToLegacyRecord(event);
}
