import type { Subscription, SubscriptionOptions } from '../events/index.js';
import type { ActionableErrorEnvelope, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState, RuntimeStatus } from '../schemas/index.js';
import type { ActorRuntimeReadModel } from '../application/read-models/actor-runtime-read-model.js';
import type { CardNotification } from './actors/card-actor.js';

export type RuntimeCommandSource = 'operator' | 'tool' | 'runtime' | 'analyst';
export type StartProjectResult =
  | {
      success: true;
      command: RuntimeCommandRecord;
      run: RuntimeRunRecord;
    }
  | { success: false; command: RuntimeCommandRecord; error: ActionableErrorEnvelope };
export interface StopProjectResult {
  success: true;
  command: RuntimeCommandRecord;
  run?: RuntimeRunRecord;
}

export interface RuntimeApi {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  pause(): void;
  resume(): void;
  notifyCard(cardId: string, notification: CardNotification): void;
  startProject(source?: RuntimeCommandSource): Promise<StartProjectResult>;
  stopProject(source?: RuntimeCommandSource): Promise<StopProjectResult>;
  subscribe(options: SubscriptionOptions): Subscription;
  getStatus(): {
    status: RuntimeStatus;
    currentCardId: string | null;
    goalCount: number;
    lastTickAt: string | null;
  };
  getActorRuntimeReadModel(): ActorRuntimeReadModel;
}
