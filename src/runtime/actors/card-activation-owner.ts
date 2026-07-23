import type { AgentName, CardNotification, CardRecord, CardStatus } from '../../schemas/index.js';
import type { CardActivationOutcome } from '../../contracts/tool-api.js';
import type { CardService } from '../../cards/card-service.js';
import type { CardProcessEntry } from '../card-process/card-process-config.js';
import type { ChildInvocationLease } from './child-invocation-wait.js';
import type { CardProcessActor } from './card-process-actor.js';
import { deferred, type Deferred } from './deferred.js';

export interface CardActivationInput {
  activationId: string;
  card: CardRecord;
  caller: CardActivationCaller;
  entry: CardProcessEntry;
  notificationDelivery: CardNotificationDeliveryPort;
  alreadyStabilizedAgents: ReadonlySet<AgentName>;
  claimResult(): void;
}

export type CardActivationCaller = { readonly kind: 'root' } | { readonly kind: 'parent'; readonly cardId: string; readonly sessionId: string };
export interface CardNotificationDeliveryPort { selectNotifications(): CardNotification[]; removeNotifications(ids: readonly string[]): void }
export interface CardCancelReason { reason: string; cancelled_at?: string }
export interface CardCancellationResult { readonly card_id: string; readonly status: 'cancelled'; readonly cancelled_card_ids: string[] }

export interface PlannerChildControlPort {
  activateChild(request: { childCardId: string; invocation: ChildInvocationLease }): Promise<CardActivationOutcome>;
  cancelChild(request: { childCardId: string; reason: string }): Promise<CardCancellationResult>;
}

export type CardActivationOwnerPhase = 'prepared_root' | 'child_admission' | 'active' | 'settling';
export type TerminalWinner = 'open' | 'result' | 'cancel';

export interface ParentActivationRelationship {
  readonly parentCardId: string;
  readonly invocation: ChildInvocationLease;
}

export class CardActivationOwner {
  readonly cardId: string;
  readonly store: CardService;
  readonly processor: CardProcessActor;
  readonly activationId: string;
  readonly entry: CardProcessEntry;
  readonly caller: CardActivationCaller;
  readonly settlement: Deferred<CardActivationOutcome> = deferred<CardActivationOutcome>();
  readonly abortController = new AbortController();
  phase: CardActivationOwnerPhase;
  terminalWinner: TerminalWinner = 'open';
  cachedStatus: CardStatus;
  parentRelationship: ParentActivationRelationship | null;
  childCardId: string | null = null;
  cancellationReason: CardCancelReason | null = null;
  cancellationSettlement: Promise<CardCancellationResult> | null = null;
  readonly alreadyStabilizedAgents: ReadonlySet<AgentName>;

  constructor(args: {
    card: CardRecord;
    store: CardService;
    processor: CardProcessActor;
    activationId: string;
    entry: CardProcessEntry;
    caller: CardActivationCaller;
    phase: Extract<CardActivationOwnerPhase, 'prepared_root' | 'child_admission'>;
    parentRelationship?: ParentActivationRelationship;
    alreadyStabilizedAgents?: ReadonlySet<AgentName>;
  }) {
    this.cardId = args.card.id;
    this.store = args.store;
    this.processor = args.processor;
    this.activationId = args.activationId;
    this.entry = args.entry;
    this.caller = args.caller;
    this.phase = args.phase;
    this.cachedStatus = args.card.lifecycle.status;
    this.parentRelationship = args.parentRelationship ?? null;
    this.alreadyStabilizedAgents = args.alreadyStabilizedAgents ?? new Set();
    void this.settlement.promise.catch(() => undefined);
  }
}
