import type { CardStatus, RuntimeState } from '../schemas/index.js';

export interface RuntimeCardPort {
  readStatus(cardId: string): CardStatus | undefined;
  canTransition(from: CardStatus, to: CardStatus): boolean;
  setStatus(cardId: string, status: CardStatus): void;
}

export interface RuntimeStatePort {
  read(): RuntimeState | null;
  patch(changes: Partial<RuntimeState>): RuntimeState;
}

export interface RuntimeErrorPort {
  appendError(error: Record<string, unknown>): void;
}

export type RuntimeSchedulerHandle = object;

export interface RuntimeSchedulerPort {
  setInterval(handler: () => void, ms: number): RuntimeSchedulerHandle;
  clearInterval(handle: RuntimeSchedulerHandle): void;
}

export interface RuntimeClockPort {
  now(): Date;
}

export interface RuntimeRedispatchPort {
  redispatch(cardId: string): void;
}
