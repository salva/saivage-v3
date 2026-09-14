import type { RuntimeState, RuntimeStatus } from '../schemas/index.js';
import type { ActorRuntimeReadModel } from '../application/read-models/actor-runtime-read-model.js';
import type { CardNotification } from '../schemas/index.js';
import type { CardCancellationResult } from './actors/card-activation-owner.js';
import type { NotificationUrgency } from '../contracts/builtin-tool-inputs.js';

interface RuntimeControlStateResult {
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
  | { ok: false; reason: 'terminal_card'; cardId: string; status: 'done' | 'failed' | 'cancelled' }
  | { ok: false; reason: 'activation_closed'; cardId: string };

type NotificationInterruptionResult =
  | { status: 'not_requested' }
  | { status: 'not_applicable' }
  | { status: 'interrupted'; stopped_card_ids: string[] }
  | { status: 'suppressed'; reason: 'cancelled' | 'runtime_ineligible' | 'stale_owner' }
  | { status: 'failed'; reason: string };

export type NotificationSubmissionResult =
  | { queued: false; reason: 'planning_ineligible'; cardId: string }
  | { queued: false; reason: 'missing_card'; cardId: string }
  | { queued: false; reason: 'terminal_card'; cardId: string; status: 'done' | 'failed' | 'cancelled' }
  | { queued: false; reason: 'activation_closed'; cardId: string }
  | { queued: true; cardId: string; notificationId: string; interruption: NotificationInterruptionResult };

export type NotificationSubmissionPort = (
  cardId: string,
  notification: CardNotification,
  urgency: NotificationUrgency,
  signal?: AbortSignal,
) => Promise<NotificationSubmissionResult>;

export interface RuntimeApi {
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stopProject(): Promise<StopProjectResult>;
  cancelCard(cardId: string, reason: string): Promise<CardCancellationResult>;
  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult;
  submitNotification(cardId: string, notification: CardNotification, urgency: NotificationUrgency, signal?: AbortSignal): Promise<NotificationSubmissionResult>;
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
