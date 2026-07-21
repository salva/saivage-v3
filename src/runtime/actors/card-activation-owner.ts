import type { CardNotification, CardRecord, CardStatus } from '../../schemas/index.js';
import type { CardActivationOutcome } from '../../contracts/tool-api.js';
import type { CardService } from '../../cards/card-service.js';
import type { TerminalLifecycleCommit } from '../../cards/card-api.js';
import type { ProcessPosition, CardProcessEntry } from '../card-process/card-process-config.js';
import type { ExecutingLlmSnapshot } from './executing-llm-snapshot.js';
import type { InvocationJoinOutcome } from './invocation-lifecycle.js';
import type { ChildInvocationLease } from './child-invocation-wait.js';
import { deferred, type Deferred } from './deferred.js';

export interface CardActivationInput {
  activationId: string;
  card: CardRecord;
  caller: CardActivationCaller;
  entry: CardProcessEntry;
  notificationDelivery: CardNotificationDeliveryPort;
  alreadyStabilizedRoles: ReadonlySet<'planner' | 'reviewer' | 'executor'>;
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

export interface CardProcessorActor {
  start(): void;
  activate(input: CardActivationInput, signal: AbortSignal): Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>;
  disposeActivation(reason: unknown): void;
  suppressContinuationAndPrepareJoin(reason: unknown): void;
  joinActivation(): Promise<readonly InvocationJoinOutcome[]>;
  pendingJoinTaskCount(): number;
  processPosition(): ProcessPosition;
  executingLlmSnapshot(): ExecutingLlmSnapshot | null;
}

export type CardActivationOwnerPhase = 'prepared_root' | 'child_admission' | 'active' | 'settling' | 'publication_unknown' | 'settled_contained';
export type TerminalWinner = 'open' | 'result' | 'cancel';
export type ContainmentOwner = 'none' | 'stop' | 'application_close';

export interface ParentActivationRelationship {
  readonly parentCardId: string;
  readonly childCardId: string;
  readonly invocation: ChildInvocationLease;
}

export class CardActivationOwner {
  readonly cardId: string;
  readonly store: CardService;
  readonly processor: CardProcessorActor;
  readonly activationId: string;
  readonly entry: CardProcessEntry;
  readonly caller: CardActivationCaller;
  readonly settlement: Deferred<CardActivationOutcome> = deferred<CardActivationOutcome>();
  readonly abortController = new AbortController();
  phase: CardActivationOwnerPhase;
  terminalWinner: TerminalWinner = 'open';
  containmentOwner: ContainmentOwner = 'none';
  cachedStatus: CardStatus;
  parentRelationship: ParentActivationRelationship | null;
  childCardId: string | null = null;
  cancellationReason: CardCancelReason | null = null;
  cancellationSettlement: Promise<CardCancellationResult> | null = null;
  publicationTask: Promise<void> = Promise.resolve();
  processorJoin: Promise<readonly InvocationJoinOutcome[]> | null = null;
  retainedPublicationFailure: unknown = null;
  retainedLocalFailure: unknown = null;
  processorActivated = false;
  readonly alreadyStabilizedRoles: ReadonlySet<'planner' | 'reviewer' | 'executor'>;

  constructor(args: {
    card: CardRecord;
    store: CardService;
    processor: CardProcessorActor;
    activationId: string;
    entry: CardProcessEntry;
    caller: CardActivationCaller;
    phase: Extract<CardActivationOwnerPhase, 'prepared_root' | 'child_admission'>;
    parentRelationship?: ParentActivationRelationship;
    alreadyStabilizedRoles?: ReadonlySet<'planner' | 'reviewer' | 'executor'>;
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
    this.alreadyStabilizedRoles = args.alreadyStabilizedRoles ?? new Set();
    void this.settlement.promise.catch(() => undefined);
  }

  processPosition(): ProcessPosition { return this.processor.processPosition(); }
}

export function cardActivationOutcomePatch(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>, completedAt: string): TerminalLifecycleCommit {
  switch (outcome.status) {
    case 'done': return { lifecycle: { status: 'done', result: outcome.result, error: null, completed_at: completedAt }, status_text: outcome.summary, status_text_updated_at: completedAt };
    case 'failed': return { lifecycle: { status: 'failed', result: outcome.result, error: outcome.summary, completed_at: completedAt }, status_text: outcome.summary, status_text_updated_at: completedAt };
    case 'blocked': return { lifecycle: { status: 'blocked', result: outcome.result, error: outcome.summary, completed_at: null }, status_text: outcome.summary, status_text_updated_at: completedAt };
  }
}
