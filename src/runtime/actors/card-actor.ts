import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import type { BlockedResult, CardRecord, CardStatus, DoneResult, FailureResult } from '../../schemas/index.js';
import { cardActorId } from './ids.js';
import { saveActorSnapshot } from './snapshots.js';

export type CardActorStatus = Extract<CardStatus, 'backlog' | 'changed' | 'running' | 'blocked' | 'failed' | 'done' | 'cancelled'>;

export type CardActivationOutcome =
  | { status: 'done'; summary: string; result: DoneResult }
  | { status: 'failed'; summary: string; result: FailureResult }
  | { status: 'blocked'; summary: string; result: BlockedResult }
  | { status: 'cancelled'; summary: string };

export interface CardActivationInput {
  card: CardRecord;
  caller: CardActivationCaller;
  notifications: CardNotification[];
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

export interface CardChange {
  reason: string;
  changed_at?: string;
}

export interface CardCancelReason {
  reason: string;
  cancelled_at?: string;
}

export interface CardProcessorActor {
  activate(input: CardActivationInput, signal: AbortSignal): Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>;
}

export interface CardActorStorePort {
  read(cardId: string): CardRecord | null;
  setStatus(cardId: string, status: CardStatus): CardRecord;
  commitTerminalLifecyclePatch(cardId: string, changes: Partial<CardRecord>): CardRecord;
  listChildren?(cardId: string): string[];
}

type PendingActivation = {
  caller: CardActivationCaller;
  resolve: (outcome: CardActivationOutcome) => void;
  reject: (error: Error) => void;
};

export class CardActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'backlog',
    states: {
      backlog: { parked: true, on: { activate: 'running', changed: 'changed', cancel: 'cancelled' } },
      changed: { parked: true, on: { activate: 'running', cancel: 'cancelled' } },
      blocked: { parked: true, on: { activate: 'running', changed: 'changed', cancel: 'cancelled' } },
      failed: { parked: true, on: { activate: 'running', changed: 'changed', cancel: 'cancelled' } },
      done: { parked: true, on: { changed: 'changed', cancel: 'cancelled' } },
      running: { on: { done: 'done', failed: 'failed', blocked: 'blocked', cancel: 'cancelled' } },
      cancelled: { terminal: true },
    },
  };

  readonly cardId: string;
  readonly projectRoot: string;
  readonly store: CardActorStorePort;
  readonly processor: CardProcessorActor;
  notifications: CardNotification[] = [];
  lastOutcome: CardActivationOutcome | null = null;
  lastChange: CardChange | null = null;
  cancelReason: CardCancelReason | null = null;
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
    return new Promise<CardActivationOutcome>((resolve, reject) => {
      this.#pendingActivation = { caller, resolve, reject };
      this.parkedSendEvent('activate');
    });
  }

  notify(notification: CardNotification): void {
    this.notifications.push(notification);
    this.persist();
  }

  markChanged(change: CardChange): void {
    this.lastChange = change;
    const card = this.requireCard();
    if (card.status !== 'running') this.writeStatus('changed');
    if (this.state() !== 'running' && this.state() !== 'changed') this.parkedSendEvent('changed');
    this.persist();
  }

  cancel(reason: CardCancelReason): void {
    this.cancelReason = reason;
    this.cancelDescendants();
    const card = this.requireCard();
    if (card.status !== 'done') this.writeStatus('cancelled');
    if (this.#pendingActivation) {
      this.#pendingActivation.resolve({ status: 'cancelled', summary: reason.reason });
      this.#pendingActivation = null;
    }
    if (this.state() === 'running') this.sendEvent('cancel');
    else if (this.state() !== 'cancelled') this.parkedSendEvent('cancel');
    this.persist();
  }

  _on_enter__running(): void {
    const card = this.requireCard();
    this.writeStatus('running');
    const pending = this.#pendingActivation;
    if (!pending) throw new Error(`Card '${this.cardId}' entered running without pending activation.`);
    const input: CardActivationInput = { card: this.requireCard(), caller: pending.caller, notifications: [...this.notifications] };
    this.runTask((signal) => this.processor.activate(input, signal), {
      on_done: (outcome) => this.commitOutcome(outcome),
      on_failed: (error) => this.commitOutcome({
        status: 'failed',
        summary: error.message,
        result: { kind: 'planner_failure', error: error.message },
      }),
    });
    this.persist();
  }

  _on_enter__backlog(): void { this.persist(); }
  _on_enter__changed(): void { this.persist(); }
  _on_enter__blocked(): void { this.persist(); }
  _on_enter__failed(): void { this.persist(); }
  _on_enter__done(): void { this.persist(); }
  _on_enter__cancelled(): void { this.persist(); }

  snapshot() {
    return {
      actor_id: cardActorId(this.cardId),
      actor_kind: 'card' as const,
      state_value: this.state(),
      context: {
        projectRoot: this.projectRoot,
        cardId: this.cardId,
        notifications: this.notifications,
        lastOutcome: this.lastOutcome,
        lastChange: this.lastChange,
        cancelReason: this.cancelReason,
      },
      updated_at: new Date().toISOString(),
    };
  }

  private commitOutcome(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): void {
    const stamp = new Date().toISOString();
    const lifecycle = outcome.status === 'done'
      ? { status: 'done' as const, result: outcome.result, error: null, completed_at: stamp }
      : outcome.status === 'failed'
        ? { status: 'failed' as const, result: outcome.result, error: outcome.summary, completed_at: stamp }
        : { status: 'blocked' as const, result: outcome.result, error: outcome.summary, completed_at: null };
    this.store.commitTerminalLifecyclePatch(this.cardId, {
      status: outcome.status,
      lifecycle,
      status_text: outcome.summary,
      status_text_updated_at: stamp,
    });
    this.lastOutcome = outcome;
    this.#pendingActivation?.resolve(outcome);
    this.#pendingActivation = null;
    this.sendEvent(outcome.status);
  }

  private writeStatus(status: CardStatus): void {
    const card = this.requireCard();
    if (card.status === status) return;
    try {
      this.store.setStatus(this.cardId, status);
    } catch (error) {
      if (status !== 'changed') throw error;
      this.store.commitTerminalLifecyclePatch(this.cardId, {
        status: 'changed',
        lifecycle: { status: 'changed', result: card.lifecycle.result, error: card.lifecycle.error, completed_at: null },
      });
    }
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

export function isActivatable(status: CardStatus): boolean {
  return status === 'backlog' || status === 'changed' || status === 'blocked' || status === 'failed';
}

function cardActorState(status: CardStatus): CardActorStatus {
  if (status === 'needs_verification') return 'blocked';
  return status as CardActorStatus;
}
