import type { CardStore } from '../cards/store-api.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { RuntimeStateMutationPort } from './mutations.js';
import type { LifecycleFlags } from './runtime-lifecycle-state.js';
import type { RuntimeStateMachine } from './state-machine.js';

export interface RuntimeServices {
  projectRoot: string;
  cards: CardStore;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  stateMachine: RuntimeStateMachine;
  mutations: RuntimeStateMutationPort;
  lifecycle: LifecycleFlags;
  emit(eventName: string, data?: Record<string, unknown>): void;
  emitRuntimeDiagnostic(input: { goal_id?: string; card_id?: string; phase?: string; error: unknown }): void;
  now(): string;
}
