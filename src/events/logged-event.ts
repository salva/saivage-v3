import type { EventKind, EventPayload } from './registry.js';
import type { LoggedEvent } from '../schemas/index.js';

export interface TypedEventEmitter {
  emit<K extends EventKind>(kind: K, payload: EventPayload<K>): void;
}

export function emitLoggedEvent(eventBus: TypedEventEmitter, event: LoggedEvent): void {
  const { kind, id: _id, timestamp: _timestamp, ...payload } = event as LoggedEvent & { kind: EventKind };
  eventBus.emit(kind, payload as EventPayload<typeof kind>);
}
