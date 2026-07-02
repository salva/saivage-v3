import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import type { BlockedResult, CardRecord, CardStatus, DoneResult, FailedResult, ReworkResult } from '../../schemas/index.js';
import type { NewCardInput } from '../../cards/store-api.js';
import type { CardMutationContext } from '../../cards/lifecycle.js';
import { cardActorId, processorActorId } from './ids.js';
import { readActorSnapshot, saveActorSnapshot } from './snapshots.js';
import type { CardActiveReconstructionRecord } from './active-reconstruction.js';
import { parseCardActorState } from './actor-vocabulary.js';
import type { CardActorState } from './actor-vocabulary.js';

export const MAX_NOTIFICATION_DELIVERY_MARKERS = 200;

export type CardActorStatus = Exclude<CardActorState, 'needs_verification'>;

export type CardActivationOutcome =
  | { status: 'done'; summary: string; result: DoneResult }
  | { status: 'failed'; summary: string; result: FailedResult }
  | { status: 'blocked'; summary: string; result: BlockedResult | ReworkResult }
  | { status: 'cancelled'; summary: string };

export interface CardActivationInput {
  card: CardRecord;
  caller: CardActivationCaller;
  notificationDelivery: CardNotificationDeliveryPort;
}

export interface CardActivationCaller {
  kind: 'root' | 'parent';
  cardId?: string;
  sessionId?: string | null;
}

export interface CardNotification {
  id: string;
  message: string;
  created_at: string;
  reason?: string;
}

export interface CardNotificationDeliveryMarker {
  notification_id: string;
  delivered_to_input_id: string;
  delivered_at: string;
}

export interface CardNotificationDeliveryPort {
  hasPendingNotifications?(): boolean;
  deliverNotificationsForInput(inputId: string): CardNotification[];
}

export interface CardChange {
  reason: string;
  changed_at?: string;
}

export interface CardCancelReason {
  reason: string;
  cancelled_at?: string;
}

export interface CardProcessorActor {
  activate(input: CardActivationInput): Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>;
}

export interface CardActorStorePort {
  read(cardId: string): CardRecord | null;
  create?(input: NewCardInput): CardRecord;
  mutateCard?(cardId: string, changes: Partial<CardRecord>, ctx: CardMutationContext): CardRecord;
  setStatus(cardId: string, status: CardStatus): CardRecord;
  commitTerminalLifecyclePatch(cardId: string, changes: Partial<CardRecord>): CardRecord;
  listChildren?(cardId: string): string[];
}

type PendingActivation = {
  caller: CardActivationCaller;
  resolve: (outcome: CardActivationOutcome) => void;
};

export class CardActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'backlog',
    states: {
      backlog: { parked: true, on: { activate: 'running', changed: 'changed', cancel: 'cancelled' } },
      changed: { parked: true, on: { activate: 'running', cancel: 'cancelled' } },
      blocked: { parked: true, on: { activate: 'running', changed: 'changed', cancel: 'cancelled' } },
      failed: { parked: true, on: { activate: 'running', changed: 'changed', cancel: 'cancelled' } },
      done: { parked: true, on: { changed: 'changed' } },
      running: { on: { done: 'done', failed: 'failed', blocked: 'blocked', cancel: 'cancelled' } },
      cancelled: { terminal: true },
    },
  };

  readonly cardId: string;
  readonly projectRoot: string;
  readonly store: CardActorStorePort;
  readonly processor: CardProcessorActor;
  notifications: CardNotification[] = [];
  notificationDeliveryMarkers: CardNotificationDeliveryMarker[] = [];
  lastOutcome: CardActivationOutcome | null = null;
  lastChange: CardChange | null = null;
  cancelReason: CardCancelReason | null = null;
  activeReconstruction: CardActiveReconstructionRecord | null = null;
  #pendingActivation: PendingActivation | null = null;

  constructor(args: { projectRoot: string; cardId: string; store: CardActorStorePort; processor: CardProcessorActor }) {
    super();
    this.projectRoot = args.projectRoot;
    this.cardId = args.cardId;
    this.store = args.store;
    this.processor = args.processor;
  }

  static fromCard(args: { projectRoot: string; card: CardRecord; store: CardActorStorePort; processor: CardProcessorActor }): CardActor {
    const actor = new CardActor({ projectRoot: args.projectRoot, cardId: args.card.id, store: args.store, processor: args.processor });
    const snapshot = readActorSnapshot(args.projectRoot, cardActorId(args.card.id));
    if (snapshot) {
      actor.notifications = Array.isArray(snapshot.context.notifications) ? snapshot.context.notifications as CardNotification[] : [];
      actor.notificationDeliveryMarkers = Array.isArray(snapshot.context.notificationDeliveryMarkers) ? snapshot.context.notificationDeliveryMarkers as CardNotificationDeliveryMarker[] : [];
      actor.lastChange = snapshot.context.lastChange && typeof snapshot.context.lastChange === 'object' ? snapshot.context.lastChange as CardChange : null;
      actor.cancelReason = snapshot.context.cancelReason && typeof snapshot.context.cancelReason === 'object' ? snapshot.context.cancelReason as CardCancelReason : null;
    }
    actor.recover(cardActorState(args.card.status));
    return actor;
  }

  activate(caller: CardActivationCaller): Promise<CardActivationOutcome> {
    const card = this.requireCard();
    if (!this.isValidCaller(card, caller)) {
      return Promise.reject(new Error(`Card '${this.cardId}' cannot be activated by caller '${caller.cardId ?? caller.kind}'.`));
    }
    if (!isActivatable(card.status)) {
      return Promise.reject(new Error(`Card '${this.cardId}' in status '${card.status}' is not activatable.`));
    }
    if (this.#pendingActivation) {
      return Promise.reject(new Error(`Card '${this.cardId}' already has a pending activation.`));
    }
    return new Promise<CardActivationOutcome>((resolve) => {
      this.#pendingActivation = { caller, resolve };
      this.activeReconstruction = {
        schema_version: 1,
        kind: 'card_activation',
        card_id: this.cardId,
        processor_actor_id: processorActorId(this.cardId),
        caller,
        started_at: new Date().toISOString(),
      };
      this.parkedSendEvent('activate');
    });
  }

  notify(notification: CardNotification): void {
    this.enqueueNotification(notification);
  }

  enqueueNotification(notification: CardNotification): void {
    this.notifications.push(notification);
    this.persist();
  }

  hasPendingNotifications(): boolean {
    return this.notifications.length > 0;
  }

  listPendingNotifications(): CardNotification[] {
    return [...this.notifications];
  }

  deliverNotificationsForInput(inputId: string): CardNotification[] {
    if (this.notifications.length === 0) return [];
    const deliveredAt = new Date().toISOString();
    const notifications = this.notifications.splice(0);
    this.notificationDeliveryMarkers.push(...notifications.map((notification) => ({
      notification_id: notification.id,
      delivered_to_input_id: inputId,
      delivered_at: deliveredAt,
    })));
    compactNotificationDeliveryMarkers(this.notificationDeliveryMarkers);
    this.persist();
    return notifications;
  }

  markChanged(change: CardChange): void {
    this.lastChange = change;
    const card = this.requireCard();
    if (card.status === 'running' || this.state() === 'running') {
      this.enqueueNotification(changeNotification(this.cardId, change));
      return;
    }
    this.writeStatus('changed');
    if (this.state() !== 'running' && this.state() !== 'changed') this.parkedSendEvent('changed');
    this.persist();
  }

  cancel(reason: CardCancelReason): void {
    const card = this.requireCard();
    if (card.status === 'done' || this.state() === 'done') return;
    if (card.status === 'running' || this.state() === 'running') {
      this.enqueueNotification(cancellationNotification(this.cardId, reason));
      return;
    }
    this.cancelReason = reason;
    this.cancelDescendants();
    this.writeStatus('cancelled');
    if (this.#pendingActivation) {
      this.#pendingActivation.resolve({ status: 'cancelled', summary: reason.reason });
      this.#pendingActivation = null;
    }
    if (this.state() !== 'cancelled') this.parkedSendEvent('cancel');
    this.persist();
  }

  _on_enter__running(): void {
    const card = this.requireCard();
    this.writeStatus('running');
    const pending = this.#pendingActivation;
    if (!pending) throw new Error(`Card '${this.cardId}' entered running without pending activation.`);
    const input: CardActivationInput = { card: this.requireCard(), caller: pending.caller, notificationDelivery: this };
    this.runTask(() => this.processor.activate(input), {
      on_done: (outcome) => this.commitOutcome(outcome),
      on_failed: (error) => this.commitOutcome({
        status: 'failed',
        summary: error.message,
        result: { kind: 'failed', summary: error.message },
      }),
    });
  }

  _on_enter__done(): void {
    this.reopenDoneWithPendingNotifications();
  }

  _on_recover__done(): void {
    // Recovery restores the durable done state without replaying done-entry invalidation side effects.
  }

  protected override _on_state_changed(_oldState: string | undefined, _newState: string): void {
    this.persist();
  }

  snapshot() {
    return {
      actor_id: cardActorId(this.cardId),
      actor_kind: 'card' as const,
      state_value: this.state(),
      context: {
        projectRoot: this.projectRoot,
        cardId: this.cardId,
        notifications: this.notifications,
        notificationDeliveryMarkers: this.notificationDeliveryMarkers,
        lastOutcome: this.lastOutcome,
        lastChange: this.lastChange,
        cancelReason: this.cancelReason,
        active_reconstruction: this.activeReconstruction,
      },
      updated_at: new Date().toISOString(),
    };
  }

  private commitOutcome(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): void {
    const stamp = new Date().toISOString();
    this.store.commitTerminalLifecyclePatch(this.cardId, cardActivationOutcomePatch(outcome, stamp));
    this.lastOutcome = outcome;
    this.activeReconstruction = null;
    this.#pendingActivation?.resolve(outcome);
    this.#pendingActivation = null;
    this.sendEvent(outcome.status);
  }

  private reopenDoneWithPendingNotifications(): void {
    if (this.notifications.length === 0) return;
    const card = this.requireCard();
    this.store.commitTerminalLifecyclePatch(this.cardId, {
      status: 'changed',
      lifecycle: { status: 'changed', result: card.lifecycle.result, error: card.lifecycle.error, completed_at: null },
    });
    if (this.state() === 'done') this.parkedSendEvent('changed');
    this.persist();
  }

  private writeStatus(status: CardStatus): void {
    const card = this.requireCard();
    if (card.status === status) return;
    if (status === 'changed' && (card.status === 'done' || card.status === 'failed' || card.status === 'blocked' || card.status === 'needs_verification')) {
      this.store.commitTerminalLifecyclePatch(this.cardId, {
        status: 'changed',
        lifecycle: { status: 'changed', result: card.lifecycle.result, error: card.lifecycle.error, completed_at: null },
      });
      return;
    }
    this.store.setStatus(this.cardId, status);
  }

  private cancelDescendants(): void {
    this.cancelDescendantIds(this.cardId);
  }

  private cancelDescendantIds(parentId: string): void {
    for (const childId of this.store.listChildren?.(parentId) ?? []) {
      const child = this.store.read(childId);
      if (!child || child.status === 'done' || child.status === 'cancelled') continue;
      this.store.setStatus(childId, 'cancelled');
      this.cancelDescendantIds(childId);
    }
  }

  private isValidCaller(card: CardRecord, caller: CardActivationCaller): boolean {
    if (card.parent === null) return caller.kind === 'root';
    return caller.kind === 'parent' && caller.cardId === card.parent;
  }

  private requireCard(): CardRecord {
    const card = this.store.read(this.cardId);
    if (!card) throw new Error(`Card '${this.cardId}' not found.`);
    return card;
  }

  private persist(): void {
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}

export function cardActivationOutcomePatch(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>, completedAt: string): Partial<CardRecord> {
  const lifecycle = outcome.status === 'done'
    ? { status: 'done' as const, result: outcome.result, error: null, completed_at: completedAt }
    : outcome.status === 'failed'
      ? { status: 'failed' as const, result: outcome.result, error: outcome.summary, completed_at: completedAt }
      : { status: 'blocked' as const, result: outcome.result, error: outcome.summary, completed_at: null };
  return {
    status: outcome.status,
    lifecycle,
    status_text: outcome.summary,
    status_text_updated_at: completedAt,
  };
}

export function isActivatable(status: CardStatus): boolean {
  return status === 'backlog' || status === 'changed' || status === 'blocked';
}

function cardActorState(status: CardStatus): CardActorStatus {
  if (status === 'needs_verification') throw new Error("CardActor cannot recover 'needs_verification' cards until an explicit actor state is implemented.");
  const actorState = parseCardActorState(status);
  if (!actorState) throw new Error(`CardActor cannot recover unknown card status '${status}'.`);
  if (actorState === 'needs_verification') throw new Error("CardActor cannot recover 'needs_verification' cards until an explicit actor state is implemented.");
  return actorState;
}

function cancellationNotification(cardId: string, reason: CardCancelReason): CardNotification {
  const createdAt = reason.cancelled_at ?? new Date().toISOString();
  return {
    id: `cancel:${cardId}:${createdAt}`,
    message: `Cancellation requested: ${reason.reason}`,
    created_at: createdAt,
    reason: 'cancel_requested',
  };
}

function changeNotification(cardId: string, change: CardChange): CardNotification {
  const createdAt = change.changed_at ?? new Date().toISOString();
  return {
    id: `change:${cardId}:${createdAt}`,
    message: `Card changed: ${change.reason}`,
    created_at: createdAt,
    reason: 'card_changed',
  };
}

function compactNotificationDeliveryMarkers(markers: CardNotificationDeliveryMarker[]): void {
  if (markers.length <= MAX_NOTIFICATION_DELIVERY_MARKERS) return;
  markers.splice(0, markers.length - MAX_NOTIFICATION_DELIVERY_MARKERS);
}
