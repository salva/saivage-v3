import type { Subscription, SubscriptionOptions } from '../events/index.js';
import type { RuntimeState, RuntimeStatus } from '../schemas/index.js';
import type { ActorRuntimeReadModel } from '../application/read-models/actor-runtime-read-model.js';
import type { CardNotification } from './actors/card-actor.js';

export type RuntimeCommandSource = 'operator' | 'tool' | 'runtime' | 'analyst';
export interface RuntimeControlStateResult {
  runtime: RuntimeState | null;
  status: RuntimeStatus;
  started: boolean;
  stopped: boolean;
  error?: string;
}
export type StartProjectResult = RuntimeControlStateResult;

export type NotifyCardResult =
  | { ok: true }
  | { ok: false; reason: 'missing_card'; cardId: string };

export interface RuntimeApi {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  pause(): void;
  resume(): void;
  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult;
  startProject(source?: RuntimeCommandSource): Promise<StartProjectResult>;
  subscribe(options: SubscriptionOptions): Subscription;
  getStatus(): {
    status: RuntimeStatus;
    currentCardId: string | null;
    goalCount: number;
    lastTickAt: string | null;
  };
  getActorRuntimeReadModel(): ActorRuntimeReadModel;
}
