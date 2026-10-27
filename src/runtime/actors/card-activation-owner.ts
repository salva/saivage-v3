import type { CardNotification, CardRecord, CardStatus } from '../../schemas/index.js';
import type { CardActivationOutcome } from '../../contracts/tool-api.js';
import type { CardProcessEntry } from '../card-process/card-process-config.js';
import type { ChildInvocationLease } from './child-invocation-wait.js';
import type { CardProcessActor } from './card-process-actor.js';
import { deferred, type Deferred } from './deferred.js';

export interface AcceptedSource {
  readonly branch_ref: string;
  readonly base_oid: string;
  readonly candidate_oid: string;
  readonly preparation_invocation_id: string;
}
export type SourcePreparation =
  | { source: AcceptedSource }
  | { refusal: import('../../schemas/lifecycle.js').GitWorkflowBlockedResult };

export interface CardActivationInput {
  activationId: string;
  card: CardRecord;
  caller: CardActivationCaller;
  entry: CardProcessEntry;
  notificationDelivery: CardNotificationDeliveryPort;
  claimResult(): void;
  nativeSource?: {
    checkpoint(ordinal: number): Promise<{ branch_ref: string; observed_tip: string }>;
    correctionPending(): boolean;
    verifyCorrection(ordinal: number): Promise<string | null>;
    completeCorrection(ordinal: number): void;
    prepareCandidate(ordinal: number): Promise<SourcePreparation>;
    verifyCandidate(ordinal: number, source: AcceptedSource): Promise<string | null>;
  };
}

type CardActivationCaller =
  | { readonly kind: 'root' }
  | {
      readonly kind: 'parent';
      readonly cardId: string;
      readonly sessionId: import('../../schemas/index.js').ConversationSessionId;
      readonly sourceInputId: string;
      readonly toolCallId: string;
      readonly toolName: 'activate_card';
      readonly instructions: string;
    };
interface CardNotificationDeliveryPort {
  hasPendingNotifications(): boolean;
  selectNotifications(): CardNotification[];
  removeNotifications(ids: readonly string[]): void;
}
interface CardCancelReason {
  reason: string;
  cancelled_at?: string;
}
export interface CardCancellationResult {
  readonly card_id: string;
  readonly status: 'cancelled';
  readonly cancelled_card_ids: string[];
}
export interface PlannerChildReopenResult {
  readonly card_id: string;
  readonly status: 'changed';
}

export interface PlannerChildControlPort {
  activateChild(request: {
    childCardId: string;
    instructions: string;
    invocation: ChildInvocationLease;
  }): Promise<CardActivationOutcome>;
  cancelChild(request: { childCardId: string; reason: string }): Promise<CardCancellationResult>;
  reopenChild(request: { childCardId: string }): PlannerChildReopenResult;
}

type CardActivationOwnerPhase = 'prepared_root' | 'child_admission' | 'active' | 'settling';
type TerminalWinner = 'open' | 'result' | 'cancel' | 'interrupt';

interface ParentActivationRelationship {
  readonly parentCardId: string;
  readonly instructions: string;
  readonly invocation: ChildInvocationLease;
}

export class CardActivationOwner {
  readonly cardId: string;
  readonly processor: CardProcessActor;
  readonly activationId: string;
  readonly entry: CardProcessEntry;
  readonly settlement: Deferred<CardActivationOutcome> = deferred<CardActivationOutcome>();
  readonly abortController = new AbortController();
  // Supervisor source settlement outlives an aborted agent, but never runtime halt.
  readonly sourceAbortController = new AbortController();
  sourceTask: Promise<void> | null = null;
  sourceReturned = false;
  entryRefusal: import('../../schemas/lifecycle.js').GitWorkflowBlockedResult | null = null;
  phase: CardActivationOwnerPhase;
  terminalWinner: TerminalWinner = 'open';
  cachedStatus: CardStatus;
  parentRelationship: ParentActivationRelationship | null;
  childCardId: string | null = null;
  cancellationReason: CardCancelReason | null = null;
  cancellationSettlement: Promise<CardCancellationResult> | null = null;
  urgentSettlement: Promise<void> | null = null;

  constructor(args: {
    card: CardRecord;
    processor: CardProcessActor;
    activationId: string;
    entry: CardProcessEntry;
    phase: Extract<CardActivationOwnerPhase, 'prepared_root' | 'child_admission'>;
    parentRelationship?: ParentActivationRelationship;
  }) {
    this.cardId = args.card.id;
    this.processor = args.processor;
    this.activationId = args.activationId;
    this.entry = args.entry;
    this.phase = args.phase;
    this.cachedStatus = args.card.lifecycle.status;
    this.parentRelationship = args.parentRelationship ?? null;
    void this.settlement.promise.catch(() => undefined);
  }
}
