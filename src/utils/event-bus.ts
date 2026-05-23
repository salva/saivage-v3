/**
 * Compatibility import location for the typed event bus.
 *
 * The implementation and event metadata source of truth live in src/events/.
 */
import { EventRegistry, getEventSeverity, type EventKind, type SeverityLevel } from '../events/index.js';

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
