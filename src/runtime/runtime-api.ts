import type { RuntimeState, RuntimeStatus } from '../schemas/index.js';
import type { ActorRuntimeReadModel } from '../application/read-models/actor-runtime-read-model.js';
import type { CardNotification } from '../schemas/index.js';
import type { CardCancellationResult } from './actors/card-activation-owner.js';

export interface RuntimeControlStateResult {
  runtime: RuntimeState | null;
  status: RuntimeStatus;
  started: boolean;
  stopped: boolean;
  error?: string;
}
export type StartProjectResult = RuntimeControlStateResult;
export interface StopProjectResult { readonly status: 'stopped'; readonly contained: boolean }

export type NotifyCardResult =
  | { ok: true; notificationId: string }
  | { ok: false; reason: 'missing_card'; cardId: string }
  | { ok: false; reason: 'terminal_card'; cardId: string; status: 'done' | 'failed' | 'cancelled' };

export interface RuntimeApi {
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stopProject(): Promise<StopProjectResult>;
  cancelCard(cardId: string, reason: string): Promise<CardCancellationResult>;
  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult;
  startProject(): Promise<StartProjectResult>;
  getStatus(): {
    status: RuntimeStatus;
    currentCardId: string | null;
    pid: number;
    startedAt: string;
  };
  getRuntimeState(): RuntimeState | null;
  getActorRuntimeReadModel(): ActorRuntimeReadModel;
}
