import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardNotification, CardRecord, CardStatus } from '../../schemas/index.js';
import type { CardActivationOutcome } from '../../contracts/tool-api.js';
import type { CardPatch, NewCardInput } from '../../cards/card-api.js';
import type { CardMutationContext } from '../../cards/lifecycle.js';
import type { CompactorPort, LLMProviderPort } from './llm-actor.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { NotifyCardResult } from '../runtime-api.js';
import type { ProcessRunner } from '../process-runner.js';
import { CardProcessActor } from './card-process-actor.js';
import type { RuntimeGate } from '../runtime-gate.js';
import { deferred, type Deferred } from './deferred.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { AppLogContext } from '../../persistence/app-log.js';
import type { RecordProjection } from '../../persistence/authored-record-files.js';
import type { InvocationJoinOutcome } from './invocation-lifecycle.js';
import type { CardService } from '../../cards/card-service.js';
import type { ActiveCardLeaf } from '../active-card-leaf.js';
import { isRuntimeStoppedInterruption, type RuntimeStopOperation } from './runtime-stopped-interruption.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';
import type { ExecutingLlmSnapshot, StructuralChildRelationship } from './executing-llm-snapshot.js';
import type { CardProcessEntry, CompiledCardProcesses } from '../card-process/card-process-config.js';
import type { ProcessPromptRegistry } from '../card-process/process-prompt-registry.js';

export interface CardActivationInput {
  activationId?: string;
  card: CardRecord;
  caller: CardActivationCaller;
  entry: CardProcessEntry;
  notificationDelivery: CardNotificationDeliveryPort;
  alreadyStabilizedRoles: ReadonlySet<'planner' | 'reviewer' | 'executor'>;
  claimResult(): void;
}

export interface RootCardActivationCaller {
  kind: 'root';
}

export interface ParentCardActivationCaller {
  kind: 'parent';
  cardId: string;
  sessionId?: string | null;
}

export type CardActivationCaller = RootCardActivationCaller | ParentCardActivationCaller;

export interface CardNotificationDeliveryPort {
  selectNotifications(): CardNotification[];
  removeNotifications(ids: readonly string[]): void;
}

export interface CardCancelReason {
  reason: string;
  cancelled_at?: string;
}

export interface CardProcessorActor {
  start?(): void;
  activate(input: CardActivationInput, signal: AbortSignal): Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>;
  disposeActivation(reason: unknown): void;
  suppressContinuationAndPrepareJoin(reason: unknown): void;
  joinActivation(): Promise<readonly InvocationJoinOutcome[]>;
  pendingJoinTaskCount(): number;
  executingLlmSnapshot(): ExecutingLlmSnapshot | null;
}

export type ActorJoinOutcome =
  | { status: 'joined' }
  | { status: 'external_dependency_abandoned'; abandonedCount: number }
  | { status: 'timed_out'; pendingTaskCount: number };

export interface CardActorStorePort {
  read(cardId: string): CardRecord | null;
  create?(input: NewCardInput): CardRecord;
  mutateCard?(cardId: string, changes: CardPatch, ctx: CardMutationContext): CardRecord;
  setStatus(cardId: string, status: CardStatus): CardRecord;
  commitTerminalLifecyclePatch(cardId: string, changes: CardPatch): CardRecord;
  listChildren?(cardId: string): string[];
  readRecord(cardId: string, filename: string, version?: number | 'latest' | 'open'): RecordProjection;
  closeRecord(cardId: string, filename: string, version: number, writer: import('../../schemas/index.js').AgentRole, cardVersionSeq: number): RecordProjection;
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection;
}

export interface CardActorDeps {
  projectRoot: string;
  storeForCard(cardId: string): CardService;
  currentness: Pick<ActiveCardLeaf, 'enterChild' | 'resumeParent'>;
  provider: LLMProviderPort;
  compactor: CompactorPort;
  compactionConfig: AutonomousCompactionPolicy;
  summarizerProvider: SummarizerProviderPort;
  gate?: RuntimeGate;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
  processRunner: ProcessRunner;
  promptTemplates: PromptTemplateRegistry;
  cardProcesses: CompiledCardProcesses;
  processPrompts: ProcessPromptRegistry;
  notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult;
  lookup: Map<string, CardActor>;
  liveLookup: Map<string, CardActor>;
  runtimeProjectionChanged(): void;
  releaseSettledActor(actor: CardActor): void;
  cancelCard(cardId: string, reason: string): Promise<CardCancellationResult>;
  conversationPublisher?: ConversationChangePublisher;
  conversations: ConversationFileContext;
  appLogs: AppLogContext;
  isRuntimeClosing(): boolean;
}

export class CardActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'parked',
    states: {
      parked: { parked: true, on: { activate: 'running', wait: 'structural_wait', cancel: 'cancelled' } },
      structural_wait: { parked: true, on: { child_settled: 'running', claim_cancel: 'cancelling', settled: 'parked' } },
      running: { on: { settled: 'parked', claim_cancel: 'cancelling' } },
      cancelling: { parked: true, on: { cancel: 'cancelled' } },
      cancelled: { terminal: true },
    },
  };

  readonly cardId: string;
  readonly deps: CardActorDeps;
  processor: CardProcessorActor | null;
  readonly store: CardService;
  lastOutcome: CardActivationOutcome | null = null;
  cancelReason: CardCancelReason | null = null;
  #result: Deferred<CardActivationOutcome> | null = null;
  #activationCaller: CardActivationCaller | null = null;
  #activationId: string | null = null;
  #activationAbort: AbortController | null = null;
  #processorStarted = false;
  #terminalClaim: 'open' | 'claimed_result' | 'claimed_cancel' | 'claimed_stop' = 'open';
  #cancelSettlement: Promise<CardCancellationResult> | null = null;
  #structuralChildId: string | null = null;
  #ordinaryStructuralRelationship: StructuralChildRelationship | null = null;
  #activationEntry: CardProcessEntry | null = null;
  #alreadyStabilizedRoles: ReadonlySet<'planner' | 'reviewer' | 'executor'> = new Set();
  #continuationSuppressed = false;
  #stopSettlementEventQueued = false;

  constructor(args: { card: CardRecord; deps: CardActorDeps; deferProcessorStart?: boolean }) {
    super();
    this.cardId = args.card.id;
    this.deps = args.deps;
    this.store = args.deps.storeForCard(this.cardId);
    this.processor = args.deferProcessorStart ? null : createProcessor(args.card, this);
    if (!args.deferProcessorStart) {
      this.processor!.start?.();
      this.#processorStarted = true;
    }
    this.deps.lookup.set(this.cardId, this);
    this.deps.runtimeProjectionChanged();
  }

  get projectRoot(): string {
    return this.deps.projectRoot;
  }

  static fromCard(args: { card: CardRecord; deps: CardActorDeps; deferProcessorStart?: boolean }): CardActor {
    const actor = new CardActor({ card: args.card, deps: args.deps, deferProcessorStart: args.deferProcessorStart });
    actor.start();
    return actor;
  }

  childCardActor(cardId: string): CardActor | null {
    const card = this.store.read(cardId);
    if (!card) return null;
    if (card.parent !== this.cardId) return null;
    const existing = this.deps.lookup.get(cardId);
    if (existing) return existing;
    return CardActor.fromCard({ card, deps: this.deps });
  }

  activate(caller: ParentCardActivationCaller, parentAdmit: () => void): Promise<CardActivationOutcome> {
    const card = this.requireCard();
    if (!this.isValidParentCaller(card, caller)) {
      return Promise.reject(new Error(`Card '${this.cardId}' cannot be activated by caller '${caller.cardId ?? caller.kind}'.`));
    }
    if (!isActivatable(card.status)) {
      return Promise.reject(new Error(`Card '${this.cardId}' in status '${card.status}' is not activatable.`));
    }
    const entry = activationEntry(card.status);
    if (this.state() !== 'parked') {
      return Promise.reject(new Error(`Card '${this.cardId}' cannot activate from actor state '${this.state()}'.`));
    }
    if (this.#result) {
      return Promise.reject(new Error(`Card '${this.cardId}' already has a pending activation.`));
    }
    parentAdmit();
    if (this.requireCard().status !== 'running') return Promise.reject(new Error(`Parent planner did not admit child '${this.cardId}' as running.`));
    this.#activationEntry = entry;
    this.#alreadyStabilizedRoles = new Set();
    this.#activationId = randomUUID();
    this.#activationCaller = caller;
    this.#result = deferred<CardActivationOutcome>();
    this.#terminalClaim = 'open';
    this.#stopSettlementEventQueued = false;
    this.claimLiveOwnership();
    this.deps.currentness.enterChild(caller.cardId, this.cardId);
    this.parkedSendEvent('activate');
    const pending = this.#result.promise;
    return pending.finally(() => this.deps.currentness.resumeParent(this.cardId, caller.cardId));
  }

  restartRunning(caller: CardActivationCaller): Promise<CardActivationOutcome> {
    const pending = this.prepareRunning(caller, 'STOPPED');
    this.startPreparedProcessor();
    return pending;
  }

  prepareRunning(caller: CardActivationCaller, entry: CardProcessEntry, alreadyStabilizedRoles: ReadonlySet<'planner' | 'reviewer' | 'executor'> = new Set()): Promise<CardActivationOutcome> {
    const card = this.requireCard();
    if (card.status !== 'running' || this.state() !== 'parked' || this.#result) throw new Error(`Card '${this.cardId}' is not an unowned running restart leaf.`);
    this.#activationId = randomUUID();
    this.#activationCaller = caller;
    this.#activationEntry = entry;
    this.#alreadyStabilizedRoles = alreadyStabilizedRoles;
    this.#result = deferred<CardActivationOutcome>();
    this.#terminalClaim = 'open';
    this.#stopSettlementEventQueued = false;
    this.claimLiveOwnership();
    return this.#result.promise;
  }

  startPreparedProcessor(): void {
    if (!this.#result || this.state() !== 'parked') throw new Error(`Card '${this.cardId}' has no prepared processor activation.`);
    this.parkedSendEvent('activate');
  }

  installStructuralWait(child: CardActor, caller: CardActivationCaller): Promise<CardActivationOutcome> {
    const card = this.requireCard();
    if (card.status !== 'running' || this.state() !== 'parked' || this.#result) throw new Error(`Card '${this.cardId}' cannot enter structural wait.`);
    if (child.requireCard().parent !== this.cardId) throw new Error(`Card '${child.cardId}' is not the immediate child of '${this.cardId}'.`);
    this.#activationId = randomUUID();
    this.#activationCaller = caller;
    this.#alreadyStabilizedRoles = new Set();
    this.#result = deferred<CardActivationOutcome>();
    this.#terminalClaim = 'open';
    this.#stopSettlementEventQueued = false;
    this.#structuralChildId = child.cardId;
    this.claimLiveOwnership();
    this.parkedSendEvent('wait');
    void child.awaitSettlement().then(
      (outcome) => {
        if (this.#terminalClaim !== 'open' || this.#continuationSuppressed || this.deps.isRuntimeClosing()) return;
        this.deps.currentness.resumeParent(child.cardId, this.cardId);
        void outcome;
        this.#activationEntry = 'STOPPED';
        this.#structuralChildId = null;
        this.parkedSendEvent('child_settled');
      },
      (error) => {
        if (isRuntimeStoppedInterruption(error)) return;
        this.#result?.reject(error);
      },
    );
    return this.#result.promise;
  }

  get structuralChildId(): string | null { return this.#structuralChildId; }
  beginOrdinaryStructuralWait(relationship: StructuralChildRelationship): StructuralChildRelationship {
    if (this.state() !== 'running' || !this.#result) throw new Error(`Card '${this.cardId}' cannot install an ordinary structural child wait outside a running activation.`);
    if (this.#structuralChildId || this.#ordinaryStructuralRelationship) throw new Error(`Card '${this.cardId}' already owns a structural child relationship.`);
    const child = this.store.read(relationship.childCardId);
    if (!child || child.parent !== this.cardId) throw new Error(`Card '${relationship.childCardId}' is not the immediate child of '${this.cardId}'.`);
    this.#structuralChildId = relationship.childCardId;
    this.#ordinaryStructuralRelationship = Object.freeze({ ...relationship });
    this.deps.runtimeProjectionChanged();
    return this.#ordinaryStructuralRelationship;
  }
  endOrdinaryStructuralWait(relationship: StructuralChildRelationship): void {
    if (this.#ordinaryStructuralRelationship !== relationship || this.#structuralChildId !== relationship.childCardId) throw new Error(`Card '${this.cardId}' structural child relationship changed before settlement.`);
    this.#ordinaryStructuralRelationship = null;
    this.#structuralChildId = null;
    this.deps.runtimeProjectionChanged();
  }
  get claim(): 'open' | 'claimed_result' | 'claimed_cancel' | 'claimed_stop' { return this.#terminalClaim; }

  stop(operation: RuntimeStopOperation): Promise<void> {
    this.#continuationSuppressed = true;
    if (this.#terminalClaim === 'open') {
      this.#terminalClaim = 'claimed_stop';
      this.#activationAbort?.abort(operation.interruption);
      this.processor?.disposeActivation(operation.interruption);
      this.#stopSettlementEventQueued = true;
      if (this.state() === 'structural_wait') this.parkedSendEvent('settled');
      else if (this.state() === 'running') this.sendEvent('settled');
    } else if (this.#terminalClaim === 'claimed_result') {
      this.processor?.suppressContinuationAndPrepareJoin(operation.interruption);
    }
    const settlement = this.#terminalClaim === 'claimed_cancel'
      ? this.settleClaimedCancellation()
      : (this.processor?.joinActivation() ?? Promise.resolve([]));
    return settlement.then(
      () => {
        if (this.#terminalClaim === 'claimed_stop' && this.#result) {
          this.#result.reject(operation.interruption);
          this.#result = null;
        }
      },
      (error) => { operation.reportContainmentFailure(`card:${this.cardId}`, error); if (this.#terminalClaim === 'claimed_stop' && this.#result) { this.#result.reject(operation.interruption); this.#result = null; } },
    );
  }

  closeForApplicationStop(): void {
    this.#continuationSuppressed = true;
    const reason = new Error('Application stopping.');
    this.#activationAbort?.abort(reason);
    this.processor?.disposeActivation(reason);
    this.#result?.reject(reason);
    this.#result = null;
    if (this.state() === 'structural_wait') this.parkedSendEvent('settled');
    else if (this.state() === 'running') this.sendEvent('settled');
  }

  awaitSettlement(caller?: { kind: 'parent'; cardId: string; sessionId?: string | null }): Promise<CardActivationOutcome> {
    if (this.#result) {
      if (!caller) return this.#result.promise;
      this.deps.currentness.enterChild(caller.cardId!, this.cardId);
      return this.#result.promise.finally(() => this.deps.currentness.resumeParent(this.cardId, caller.cardId!));
    }
    const card = this.requireCard();
    if (card.status === 'done' || card.status === 'failed' || card.status === 'blocked') {
      return Promise.resolve({ status: card.status, summary: cardLifecycleSummary(card), result: card.lifecycle.result as never });
    }
    if (card.status === 'cancelled') return Promise.resolve({ status: 'cancelled', summary: cardLifecycleSummary(card) });
    return Promise.reject(new Error(`Card '${this.cardId}' has no in-flight activation to await.`));
  }

  enqueueNotification(notification: CardNotification): void {
    this.store.enqueueNotification(this.cardId, notification);
  }

  hasPendingNotifications(): boolean {
    return this.requireCard().pending_notifications.length > 0;
  }

  listPendingNotifications(): CardNotification[] {
    return [...this.requireCard().pending_notifications];
  }

  hasLiveActivation(): boolean { return this.deps.liveLookup.get(this.cardId) === this && this.#result !== null; }

  cancel(reason: CardCancelReason): Promise<CardCancellationResult> {
    if (this.#cancelSettlement) return this.#cancelSettlement;
    if (!this.hasLiveActivation()) return Promise.reject(new Error(`Card '${this.cardId}' has no live activation owner.`));
    if (this.#terminalClaim === 'claimed_result') return this.#result!.promise.then(() => { throw new Error(`Card '${this.cardId}' result already claimed the activation.`); });
    this.claimCancellation(reason);
    return this.settleClaimedCancellation();
  }

  canClaimCancellation(): boolean { return this.hasLiveActivation() && this.#terminalClaim === 'open'; }

  claimCancellation(reason: CardCancelReason): void {
    if (!this.hasLiveActivation()) throw new Error(`Card '${this.cardId}' has no live activation owner.`);
    if (this.#terminalClaim !== 'open') throw new Error(`Card '${this.cardId}' has invalid cancellation claim state '${this.#terminalClaim}'.`);
    this.#terminalClaim = 'claimed_cancel';
    this.cancelReason = reason;
    const cancellationError = new Error(reason.reason);
    this.#activationAbort?.abort(cancellationError);
    this.processor?.disposeActivation(cancellationError);
  }

  settleClaimedCancellation(): Promise<CardCancellationResult> {
    if (this.#cancelSettlement) return this.#cancelSettlement;
    if (this.#terminalClaim !== 'claimed_cancel') return Promise.reject(new Error(`Card '${this.cardId}' cancellation was not claimed.`));
    if (!this.cancelReason) throw new Error(`Card '${this.cardId}' claimed cancellation without a reason.`);
    const settlement = this.finishCancellation(this.cancelReason);
    this.#cancelSettlement = settlement;
    return settlement;
  }

  async join(options: { timeoutMs: number }): Promise<ActorJoinOutcome> {
    let awaitingLifecycle = false;
    const settlement = (async (): Promise<ActorJoinOutcome> => {
      const processorOutcomes = await this.processor?.joinActivation() ?? [];
      awaitingLifecycle = true;
      await this.awaitLifecycleSettlement();
      awaitingLifecycle = false;
      const abandonedCount = processorOutcomes.reduce((count, outcome) => count + (outcome.status === 'external_dependency_abandoned' ? outcome.abandonedCount : 0), 0);
      return abandonedCount === 0 ? { status: 'joined' } : { status: 'external_dependency_abandoned', abandonedCount };
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ActorJoinOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timed_out', pendingTaskCount: awaitingLifecycle ? 1 : (this.processor?.pendingJoinTaskCount() ?? 0) }), options.timeoutMs);
    });
    try {
      return await Promise.race([settlement, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async joinForApplicationStop(): Promise<void> {
    await this.processor?.joinActivation();
    await this.awaitLifecycleSettlement();
  }

  _on_enter__running(): void {
    this.beginProcessorActivation();
  }

  private beginProcessorActivation(): void {
    if (this.#continuationSuppressed || this.deps.isRuntimeClosing()) { this.sendEvent('settled'); return; }
    if (!this.processor) this.processor = createProcessor(this.requireCard(), this);
    if (!this.#processorStarted) {
      this.processor.start?.();
      this.#processorStarted = true;
    }
    if (!this.#result) throw new Error(`Card '${this.cardId}' entered running without pending activation.`);
    if (!this.#activationId) throw new Error(`Card '${this.cardId}' entered running without an activation id.`);
    const caller = this.#activationCaller;
    if (!caller) throw new Error(`Card '${this.cardId}' entered running without an activation caller.`);
    const notificationDelivery: CardNotificationDeliveryPort = {
      selectNotifications: () => this.listPendingNotifications(),
      removeNotifications: (ids) => { this.store.removeNotifications(this.cardId, [...ids]); },
    };
    const card = this.requireCard();
    const entry = this.#activationEntry;
    if (!entry) throw new Error(`Card '${this.cardId}' entered running without a lifecycle entry.`);
    const input: CardActivationInput = { activationId: this.#activationId, card, caller, entry, notificationDelivery, alreadyStabilizedRoles: this.#alreadyStabilizedRoles, claimResult: () => this.claimResult() };
    this.#activationAbort = new AbortController();
    this.runTask(async () => {
      return this.processor!.activate(input, this.#activationAbort!.signal);
    }, {
      on_done: (outcome) => this.commitOutcome(outcome),
      on_failed: (error) => {
        if (this.#terminalClaim === 'claimed_cancel') {
          if (this.state() === 'running') this.sendEvent('claim_cancel');
          return;
        }
        if (this.#continuationSuppressed) return;
        if (isRuntimeStoppedInterruption(error)) { this.#result?.reject(error); return; }
        this.commitOutcome({ status: 'failed', summary: error.message, result: { kind: 'failed', summary: error.message } });
      },
    });
  }

  private commitOutcome(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): void {
    if (this.#terminalClaim === 'claimed_cancel') {
      if (this.state() === 'running') this.sendEvent('claim_cancel');
      return;
    }
    if (this.#continuationSuppressed && this.#terminalClaim !== 'claimed_result') return;
    if (this.#terminalClaim === 'open') this.#terminalClaim = 'claimed_result';
    if (this.#terminalClaim !== 'claimed_result') throw new Error(`Card '${this.cardId}' cannot commit from claim '${this.#terminalClaim}'.`);
    const result = this.#result;
    if (!result) throw new Error(`Card '${this.cardId}' result claim has no activation settlement.`);
    this.store.commitTerminalLifecyclePatch(this.cardId, cardActivationOutcomePatch(outcome, new Date().toISOString()));
    this.lastOutcome = outcome;
    this.#activationId = null;
    this.#activationAbort = null;
    this.#activationCaller = null;
    this.#activationEntry = null;
    this.sendEvent('settled');
    this.releaseSettledOwnership();
    this.#result = null;
    result.resolve(outcome);
  }

  private writeStoreStatus(status: CardStatus): void {
    const card = this.requireCard();
    if (card.status === status) return;
    this.store.setStatus(this.cardId, status);
  }

  private claimResult(): void {
    this.#activationAbort?.signal.throwIfAborted();
    if (this.#terminalClaim !== 'open') throw new Error(`Card '${this.cardId}' activation is already ${this.#terminalClaim}.`);
    this.#terminalClaim = 'claimed_result';
  }

  private claimLiveOwnership(): void {
    if (this.deps.liveLookup.has(this.cardId)) throw new Error(`Card '${this.cardId}' already has a live activation owner.`);
    this.deps.liveLookup.set(this.cardId, this);
  }

  private releaseSettledOwnership(): void {
    if (!this.deps.isRuntimeClosing()) this.deps.releaseSettledActor(this);
  }

  private async finishCancellation(reason: CardCancelReason): Promise<CardCancellationResult> {
    const cancelledIds: string[] = [];
    await this.cancelDescendantIds(this.cardId, reason, cancelledIds);
    await this.processor?.joinActivation();
    await Promise.resolve();
    await this.awaitLifecycleSettlement();
    this.writeStoreStatus('cancelled');
    cancelledIds.push(this.cardId);
    const result = this.#result;
    if (!result) throw new Error(`Card '${this.cardId}' cancellation lost its activation settlement.`);
    result.resolve({ status: 'cancelled', summary: reason.reason });
    this.#result = null;
    this.#activationCaller = null;
    this.#activationEntry = null;
    this.#activationId = null;
    this.#activationAbort = null;
    if (this.state() === 'running') this.sendEvent('cancel');
    else this.parkedSendEvent('cancel');
    this.releaseSettledOwnership();
    return { card_id: this.cardId, status: 'cancelled', cancelled_card_ids: cancelledIds };
  }

  private async cancelDescendantIds(parentId: string, reason: CardCancelReason, cancelledIds: string[]): Promise<void> {
    for (const childId of this.store.listChildren(parentId)) {
      const child = this.store.read(childId);
      if (!child || child.status === 'done' || child.status === 'cancelled') continue;
      const live = this.deps.liveLookup.get(childId);
      if (live) {
        const result = await live.cancel({ reason: `ancestor cancelled: ${reason.reason}`, cancelled_at: reason.cancelled_at });
        cancelledIds.push(...result.cancelled_card_ids);
        continue;
      }
      if (child.status === 'running') throw new Error(`Running card '${childId}' has no live activation owner.`);
      await this.cancelDescendantIds(childId, reason, cancelledIds);
      this.store.setStatus(childId, 'cancelled');
      cancelledIds.push(childId);
    }
  }

  private isValidParentCaller(card: CardRecord, caller: CardActivationCaller): boolean {
    return caller.kind === 'parent' && card.parent !== null && caller.cardId === card.parent;
  }

  private requireCard(): CardRecord {
    const card = this.store.read(this.cardId);
    if (!card) throw new Error(`Card '${this.cardId}' not found.`);
    return card;
  }

}

export interface CardCancellationResult { readonly card_id: string; readonly status: 'cancelled'; readonly cancelled_card_ids: string[] }

function cardLifecycleSummary(card: CardRecord): string {
  const summary = card.lifecycle?.result?.summary;
  if (typeof summary === 'string' && summary.length > 0) return summary;
  if (typeof card.status_text === 'string' && card.status_text.length > 0) return card.status_text;
  return `Card '${card.id}' finished with status '${card.status}'.`;
}

export function createProcessor(card: CardRecord, owner: CardActor): CardProcessorActor {
  const process = card.type === 'project' || card.type === 'goal' ? owner.deps.cardProcesses.planning : owner.deps.cardProcesses.terminal;
  return new CardProcessActor({
      projectRoot: owner.deps.projectRoot,
      cardId: card.id,
      process,
      processPrompts: owner.deps.processPrompts,
      store: owner.store,
      children: { get: (childId) => owner.childCardActor(childId) },
      ownerStructuralWait: { begin: (relationship) => owner.beginOrdinaryStructuralWait(relationship), end: (relationship) => owner.endOrdinaryStructuralWait(relationship) },
      cancelCard: owner.deps.cancelCard,
      provider: owner.deps.provider,
      conversations: owner.deps.conversations,
      appLogs: owner.deps.appLogs,
      processRunner: owner.deps.processRunner,
      gate: owner.deps.gate,
      notifyCard: owner.deps.notifyCard,
      mcpManagerProvider: owner.deps.mcpManagerProvider,
      compactor: owner.deps.compactor,
      compactionConfig: owner.deps.compactionConfig,
      summarizerProvider: owner.deps.summarizerProvider,
      promptTemplates: owner.deps.promptTemplates,
      conversationPublisher: owner.deps.conversationPublisher,
      runtimeProjectionChanged: owner.deps.runtimeProjectionChanged,
  });
}

export function cardActivationOutcomePatch(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>, completedAt: string): CardPatch {
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
  return status === 'backlog' || status === 'changed' || status === 'blocked' || status === 'stopped';
}

function activationEntry(status: CardStatus): CardProcessEntry {
  if (status === 'backlog') return 'BACKLOG';
  if (status === 'changed') return 'CHANGED';
  if (status === 'blocked') return 'BLOCKED';
  if (status === 'stopped') return 'STOPPED';
  throw new Error(`Card status '${status}' has no process entry.`);
}

import { randomUUID } from 'node:crypto';
