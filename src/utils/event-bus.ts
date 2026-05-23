/**
 * Compatibility import location for the typed event bus.
 *
 * The implementation and event metadata source of truth live in src/events/.
 */
import { EventRegistry, runtimeEventKindValues, agentEventKindValues, eventKindValues, getEventSeverity, type EventKind, type SeverityLevel } from '../events/index.js';

export {
  EventBus,
  BusDisposed,
  SEVERITY_ORDER,
  toLoggedEvent,
  type DomainEvent,
  type EventHandler,
  type EventPayload,
  type Subscription as EventBusSubscription,
  type SubscriptionOptions,
} from '../events/index.js';

export { EventRegistry, getEventSeverity as getSeverity, type EventKind, type SeverityLevel };
export const RUNTIME_SEVERITY_MAP = Object.fromEntries(runtimeEventKindValues.map((kind) => [kind, getEventSeverity(kind)])) as Record<EventKind, SeverityLevel>;
export const AGENT_SEVERITY_MAP = Object.fromEntries(agentEventKindValues.map((kind) => [kind, getEventSeverity(kind)])) as Record<EventKind, SeverityLevel>;
export const SEVERITY_MAP = { ...Object.fromEntries(eventKindValues.map((kind) => [kind, getEventSeverity(kind)])), error: 'error' } as Record<EventKind | 'error', SeverityLevel>;
