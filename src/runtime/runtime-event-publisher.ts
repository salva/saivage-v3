import type {
  ActionableErrorEnvelope,
  RuntimeDiagnosticEvent,
  RuntimeActivationRecord,
  RuntimeCommandRecord,
  RuntimeRunRecord,
} from '../schemas/index.js';
import { EventBus, emitLoggedEvent, eventKindValues, trackedEventKindValues, type EventPayload } from '../events/index.js';
import type { EventKind } from '../events/index.js';
import type { EventLogger } from '../observability/index.js';

const TRACKED_EVENT_KINDS: ReadonlySet<EventKind> = new Set(trackedEventKindValues);
const EVENT_KINDS: ReadonlySet<EventKind> = new Set(eventKindValues);

export interface RuntimeDiagnosticInput {
  goal_id?: string;
  card_id?: string;
  phase?: string;
  error: unknown;
}

export type RuntimeDiagnosticEventInput = Pick<RuntimeDiagnosticEvent, 'kind' | 'goal_id' | 'card_id' | 'phase' | 'error_message' | 'error_name'>;

export function buildRuntimeDiagnosticEvent(input: RuntimeDiagnosticInput): RuntimeDiagnosticEventInput {
  const error = input.error instanceof Error ? input.error : new Error(String(input.error));
  return {
    kind: 'runtime_diagnostic',
    error_message: error.message,
    error_name: error.name,
    ...(input.goal_id !== undefined ? { goal_id: input.goal_id } : {}),
    ...(input.card_id !== undefined ? { card_id: input.card_id } : {}),
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
  };
}

export class RuntimeEventPublisher {
  readonly eventBus: EventBus;

  constructor(
    private readonly eventLogger: EventLogger,
    eventBus: EventBus,
  ) {
    this.eventBus = eventBus;
  }

  on(eventName: string | symbol, listener: (...args: unknown[]) => void): void {
    if (typeof eventName !== 'string' || !EVENT_KINDS.has(eventName as EventKind)) {
      void listener;
      return;
    }
    this.eventBus.subscribe(eventName as EventKind, (event) => {
      listener(event.payload);
    });
  }

  emit(eventName: string, ...args: unknown[]): boolean {
    if (TRACKED_EVENT_KINDS.has(eventName as EventKind)) {
      const data =
        args[0] && typeof args[0] === 'object'
          ? (args[0] as Record<string, unknown>)
          : { raw: args[0] };
      this.eventBus.emit(eventName as EventKind, data as EventPayload<EventKind>);
      return true;
    }
    return false;
  }

  emitAgentEvent(name: string, data: Record<string, unknown>): void {
    this.emit(name, data);
  }

  publishRuntimeDiagnostic(input: RuntimeDiagnosticInput): void {
    const event = buildRuntimeDiagnosticEvent(input);
    this.emit('runtime_diagnostic', {
      goal_id: event.goal_id,
      card_id: event.card_id,
      phase: event.phase,
      error_message: event.error_message,
      error_name: event.error_name,
    });
    try {
      this.eventLogger.appendEvent(event);
    } catch (err) {
      console.warn('Failed to append runtime diagnostic event:', err);
    }
  }

  publishRuntimeLedgerEvent(kind: 'runtime_command', payload: { command: RuntimeCommandRecord }): void;
  publishRuntimeLedgerEvent(kind: 'runtime_run', payload: { run: RuntimeRunRecord }): void;
  publishRuntimeLedgerEvent(
    kind: 'runtime_activation',
    payload: { activation: RuntimeActivationRecord },
  ): void;
  publishRuntimeLedgerEvent(
    kind: 'runtime_actionable_error',
    payload: { actionable_error: ActionableErrorEnvelope },
  ): void;
  publishRuntimeLedgerEvent(
    kind: 'runtime_command' | 'runtime_run' | 'runtime_activation' | 'runtime_actionable_error',
    payload: Record<string, unknown>,
  ): void {
    const logged = this.eventLogger.appendEvent({ kind, ...payload });
    emitLoggedEvent(this.eventBus, logged);
  }
}
