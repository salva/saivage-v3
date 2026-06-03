import { EventEmitter } from 'node:events';
import type {
  ActionableErrorEnvelope,
  RuntimeActivationRecord,
  RuntimeCommandRecord,
  RuntimeRunRecord,
} from '../schemas/index.js';
import { EventBus, trackedEventKindValues, type EventPayload } from '../events/index.js';
import type { EventKind } from '../events/index.js';
import type { EventLogger } from '../observability/index.js';
import { buildCurrentAgentSessionPatch } from './runtime-core.js';
import type { RuntimeStateMutationPort } from './mutations.js';

const TRACKED_EVENT_KINDS: ReadonlySet<EventKind> = new Set(trackedEventKindValues);

export class RuntimeEventPublisher {
  readonly eventBus = new EventBus();
  private readonly eventEmitter = new EventEmitter();

  constructor(
    private readonly eventLogger: EventLogger,
    private readonly mutations: RuntimeStateMutationPort,
  ) {}

  on(eventName: string | symbol, listener: (...args: unknown[]) => void): void {
    this.eventEmitter.on(eventName, listener);
  }

  emit(eventName: string, ...args: unknown[]): boolean {
    const emitted = eventName === 'error' ? false : this.eventEmitter.emit(eventName, ...args);
    if (TRACKED_EVENT_KINDS.has(eventName as EventKind)) {
      const data =
        args[0] && typeof args[0] === 'object'
          ? (args[0] as Record<string, unknown>)
          : { raw: args[0] };
      this.eventBus.emit(eventName as EventKind, data as EventPayload<EventKind>);
    }
    return emitted;
  }

  emitAgentEvent(name: string, data: Record<string, unknown>): void {
    if (name === 'session_started' && typeof data.session_id === 'string') {
      try {
        this.mutations.apply({ kind: 'patchRuntimeState', patch: buildCurrentAgentSessionPatch(data.session_id) });
      } catch {
        void 0;
      }
    }
    this.emit(name, data);
  }

  emitRuntimeDiagnostic(input: {
    goal_id?: string;
    card_id?: string;
    phase?: string;
    error: unknown;
  }): void {
    const error = input.error instanceof Error ? input.error : new Error(String(input.error));
    this.emit('runtime_diagnostic', {
      goal_id: input.goal_id,
      card_id: input.card_id,
      phase: input.phase,
      error_message: error.message,
      error_name: error.name,
    });
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
    this.eventBus.emit(logged);
    this.eventEmitter.emit(kind, payload);
  }
}
