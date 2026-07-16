import type { Subscription, SubscriptionOptions } from '../events/index.js';
import type { RuntimeState, RuntimeStatus } from '../schemas/index.js';
import type { ActorRuntimeReadModel } from '../application/read-models/actor-runtime-read-model.js';
import type { CardNotification } from '../schemas/index.js';
import type { CardCancellationResult } from './actors/card-actor.js';

export type RuntimeCommandSource = 'operator' | 'tool' | 'runtime' | 'analyst';
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
  startProject(source?: RuntimeCommandSource): Promise<StartProjectResult>;
  subscribe(options: SubscriptionOptions): Subscription;
  getStatus(): {
    status: RuntimeStatus;
    currentCardId: string | null;
    goalCount: number;
    lastTickAt: string | null;
  };
  getRuntimeState(): RuntimeState | null;
  getActorRuntimeReadModel(): ActorRuntimeReadModel;
}
