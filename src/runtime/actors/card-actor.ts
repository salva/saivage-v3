import { BaseActor } from '../micro-actor/index.js';
import type { ActorDefinition } from '../micro-actor/index.js';
import type { BlockedResult, CardRecord, CardStatus, DoneResult, FailedResult, ReworkResult } from '../../schemas/index.js';
import type { NewCardInput } from '../../cards/store-api.js';
import type { CardMutationContext } from '../../cards/lifecycle.js';
import { cardActorId, processorActorId } from './ids.js';
import { readActorSnapshot, type ActorSnapshotStore } from './snapshots.js';
import type { CardActiveReconstructionRecord } from './active-reconstruction.js';
import type { CompactorPort, LLMProviderPort } from './llm-actor.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { NotifyCardResult } from '../runtime-api.js';
import type { ProcessRunner } from '../process-runner.js';
import { PlanningCardProcessorActor } from './planning-card-processor-actor.js';
import { TerminalCardProcessorActor } from './terminal-card-processor-actor.js';
import type { RuntimeGate } from '../runtime-gate.js';
import { deferred, type Deferred } from './deferred.js';
import type { BufferSizeEstimator, CompactionConfig } from './compaction/compactor.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { ConversationMutationPort } from '../../persistence/conversation-mutation-port.js';
import type { RecordProjection } from '../../persistence/project-persistence-authority.js';
import type { InvocationJoinOutcome } from './invocation-lifecycle.js';

export const MAX_NOTIFICATION_DELIVERY_MARKERS = 200;

export type CardActivationOutcome =
  | { status: 'done'; summary: string; result: DoneResult }
  | { status: 'failed'; summary: string; result: FailedResult }
  | { status: 'blocked'; summary: string; result: BlockedResult | ReworkResult }
  | { status: 'cancelled'; summary: string };

export interface CardActivationInput {
  activationId?: string;
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
  deliverNotificationsForInput(inputId: string): CardNotification[];
}

export interface CardCancelReason {
  reason: string;
  cancelled_at?: string;
}

export interface CardProcessorActor {
  start?(): void;
  recoverActive?(state: string, input: CardActivationInput, signal: AbortSignal): Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>;
  activate(input: CardActivationInput, signal: AbortSignal): Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>;
  disposeActivation(reason: unknown): void;
  joinActivation(): Promise<readonly InvocationJoinOutcome[]>;
}

export type ActorJoinOutcome =
  | { status: 'joined' }
  | { status: 'external_dependency_abandoned'; abandonedCount: number }
  | { status: 'timed_out'; pendingTaskCount: number };

export interface CardActorStorePort {
  read(cardId: string): CardRecord | null;
  create?(input: NewCardInput): CardRecord;
  mutateCard?(cardId: string, changes: Partial<CardRecord>, ctx: CardMutationContext): CardRecord;
  setStatus(cardId: string, status: CardStatus): CardRecord;
  commitTerminalLifecyclePatch(cardId: string, changes: Partial<CardRecord>): CardRecord;
  listChildren?(cardId: string): string[];
  readRecord(cardId: string, filename: string, version?: number | 'latest' | 'open'): RecordProjection;
  closeRecord(cardId: string, filename: string, version: number, writer: import('../../schemas/index.js').AgentRole, cardVersionSeq: number): RecordProjection;
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection;
}

export interface CardActorDeps {
  projectRoot: string;
  store: CardActorStorePort;
  provider: LLMProviderPort;
  compactor?: CompactorPort;
  compactionConfig?: CompactionConfig;
  summarizerProvider?: LLMProviderPort;
  bufferSizeEstimator?: BufferSizeEstimator;
  gate?: RuntimeGate;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
  processRunner: ProcessRunner;
  promptTemplates: PromptTemplateRegistry;
  notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult;
  lookup: Map<string, CardActor>;
  conversationPublisher?: ConversationChangePublisher;
  conversations: ConversationMutationPort;
  snapshots: ActorSnapshotStore;
}

export class CardActor extends BaseActor {
  static _actor: ActorDefinition = {
    initial: 'parked',
    states: {
      parked: { parked: true, on: { activate: 'running', cancel: 'cancelled' } },
      running: { on: { settled: 'parked', cancel: 'cancelled' } },
      cancelled: { terminal: true },
    },
  };

  readonly cardId: string;
  readonly deps: CardActorDeps;
  readonly processor: CardProcessorActor;
  notifications: CardNotification[] = [];
  notificationDeliveryMarkers: CardNotificationDeliveryMarker[] = [];
  lastOutcome: CardActivationOutcome | null = null;
  cancelReason: CardCancelReason | null = null;
  activeReconstruction: CardActiveReconstructionRecord | null = null;
  #result: Deferred<CardActivationOutcome> | null = null;
  #activationCaller: CardActivationCaller | null = null;
  #activationId: string | null = null;
  #activationAbort: AbortController | null = null;
  #activationCounter = 0;
  #processorStarted = false;

  constructor(args: { card: CardRecord; deps: CardActorDeps; deferProcessorStart?: boolean }) {
    super();
    this.cardId = args.card.id;
    this.deps = args.deps;
    this.processor = createProcessor(args.card, this);
    if (!args.deferProcessorStart) {
      this.processor.start?.();
      this.#processorStarted = true;
    }
    this.deps.lookup.set(this.cardId, this);
  }

  get projectRoot(): string {
    return this.deps.projectRoot;
  }

  get store(): CardActorStorePort {
    return this.deps.store;
  }

  static fromCard(args: { card: CardRecord; deps: CardActorDeps; deferRunningRecovery?: boolean }): CardActor {
    const deferProcessorStart = args.deferRunningRecovery === true && args.card.status === 'running';
    const actor = new CardActor({ card: args.card, deps: args.deps, deferProcessorStart });
    const snapshot = readActorSnapshot(args.deps.projectRoot, cardActorId(args.card.id));
    if (snapshot) {
      actor.notifications = Array.isArray(snapshot.context.notifications) ? snapshot.context.notifications as CardNotification[] : [];
      actor.notificationDeliveryMarkers = Array.isArray(snapshot.context.notificationDeliveryMarkers) ? snapshot.context.notificationDeliveryMarkers as CardNotificationDeliveryMarker[] : [];
      actor.cancelReason = snapshot.context.cancelReason && typeof snapshot.context.cancelReason === 'object' ? snapshot.context.cancelReason as CardCancelReason : null;
      actor.activeReconstruction = snapshot.context.active_reconstruction && typeof snapshot.context.active_reconstruction === 'object' ? snapshot.context.active_reconstruction as CardActiveReconstructionRecord : null;
      actor.#activationId = typeof snapshot.context.activationId === 'string' ? snapshot.context.activationId : null;
    }
    const hadStaleActiveState = args.card.status !== 'running' && (actor.activeReconstruction !== null || actor.#activationId !== null);
    if (args.card.status === 'running' && !actor.activeReconstruction) {
      throw new Error(`Card '${args.card.id}' is running without active reconstruction.`);
    }
    if (args.card.status === 'running') {
      actor.#result = deferred<CardActivationOutcome>();
      actor.#activationCaller = actor.activeReconstruction!.caller;
      actor.#activationId ??= `card:${actor.cardId}:activation:recovered`;
    } else {
      actor.activeReconstruction = null;
      actor.#activationId = null;
    }
    if (!(args.deferRunningRecovery && args.card.status === 'running')) actor.recover(cardActorLifecycleState(args.card.status));
    if (hadStaleActiveState) actor.persist();
    return actor;
  }

  recoverCurrentCardState(): void {
    const card = this.requireCard();
    if (card.status === 'running' && !this.activeReconstruction) throw new Error(`Card '${this.cardId}' is running without active reconstruction.`);
    const hadStaleActiveState = card.status !== 'running' && (this.activeReconstruction !== null || this.#activationId !== null);
    if (hadStaleActiveState) {
      this.activeReconstruction = null;
      this.#activationId = null;
    }
    this.recover(cardActorLifecycleState(card.status));
    if (hadStaleActiveState) this.persist();
  }

  childCardActor(cardId: string): CardActor | null {
    const card = this.store.read(cardId);
    if (!card) return null;
    if (card.parent !== this.cardId) return null;
    const existing = this.deps.lookup.get(cardId);
    if (existing) return existing;
    return CardActor.fromCard({ card, deps: this.deps });
  }

  activate(caller: CardActivationCaller): Promise<CardActivationOutcome> {
    const card = this.requireCard();
    if (!this.isValidCaller(card, caller)) {
      return Promise.reject(new Error(`Card '${this.cardId}' cannot be activated by caller '${caller.cardId ?? caller.kind}'.`));
    }
    if (!isActivatable(card.status)) {
      return Promise.reject(new Error(`Card '${this.cardId}' in status '${card.status}' is not activatable.`));
    }
    if (this.state() !== 'parked') {
      return Promise.reject(new Error(`Card '${this.cardId}' cannot activate from actor state '${this.state()}'.`));
    }
    if (this.#result) {
      return Promise.reject(new Error(`Card '${this.cardId}' already has a pending activation.`));
    }
    this.#activationCounter++;
    this.#activationId = `card:${this.cardId}:activation:${this.#activationCounter}`;
    this.#activationCaller = caller;
    this.#result = deferred<CardActivationOutcome>();
    this.activeReconstruction = {
      schema_version: 1,
      kind: 'card_activation',
      card_id: this.cardId,
      processor_actor_id: processorActorId(this.cardId),
      caller,
      started_at: new Date().toISOString(),
    };
    this.parkedSendEvent('activate');
    return this.#result.promise;
  }

  awaitSettlement(): Promise<CardActivationOutcome> {
    if (this.#result) return this.#result.promise;
    const card = this.requireCard();
    if (card.status === 'done' || card.status === 'failed' || card.status === 'blocked') {
      return Promise.resolve({ status: card.status, summary: cardLifecycleSummary(card), result: card.lifecycle.result as never });
    }
    if (card.status === 'cancelled') return Promise.resolve({ status: 'cancelled', summary: cardLifecycleSummary(card) });
    return Promise.reject(new Error(`Card '${this.cardId}' has no in-flight activation to await.`));
  }

  enqueueNotification(notification: CardNotification): void {
    this.notifications.push(notification);
    this.persist();
  }

  markChanged(): void {
    const card = this.requireCard();
    if (card.status === 'cancelled') return;
    if (this.state() === 'running') {
      this.persist();
      return;
    }
    this.writeStoreStatus('changed');
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

  cancel(reason: CardCancelReason): void {
    const card = this.requireCard();
    if (this.state() === 'cancelled' || card.status === 'done') return;
    this.cancelReason = reason;
    this.cancelDescendants();
    this.activeReconstruction = null;
    this.writeStoreStatus('cancelled');
    this.processor.disposeActivation(new Error(reason.reason));
    this.#activationAbort?.abort(new Error(reason.reason));
    this.#result?.resolve({ status: 'cancelled', summary: reason.reason });
    this.#result = null;
    this.#activationCaller = null;
    this.#activationId = null;
    this.#activationAbort = null;
    if (this.state() === 'running') this.sendEvent('cancel');
    else this.parkedSendEvent('cancel');
    this.persist();
  }

  async join(options: { timeoutMs: number }): Promise<ActorJoinOutcome> {
    const settlement = (async (): Promise<ActorJoinOutcome> => {
      const processorOutcomes = await this.processor.joinActivation();
      await this.awaitLifecycleSettlement();
      const abandonedCount = processorOutcomes.reduce((count, outcome) => count + (outcome.status === 'external_dependency_abandoned' ? outcome.abandonedCount : 0), 0);
      return abandonedCount === 0 ? { status: 'joined' } : { status: 'external_dependency_abandoned', abandonedCount };
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ActorJoinOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timed_out', pendingTaskCount: 1 }), options.timeoutMs);
    });
    try {
      return await Promise.race([settlement, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _on_enter__running(): void {
    this.beginProcessorActivation('fresh');
  }

  _on_recover__running(): void {
    this.beginProcessorActivation('recovery');
  }

  private beginProcessorActivation(mode: 'fresh' | 'recovery'): void {
    if (!this.#processorStarted) {
      this.processor.start?.();
      this.#processorStarted = true;
    }
    this.writeStoreStatus('running');
    if (!this.#result) throw new Error(`Card '${this.cardId}' entered running without pending activation.`);
    if (!this.#activationId) throw new Error(`Card '${this.cardId}' entered running without an activation id.`);
    const caller = this.#activationCaller;
    if (!caller) throw new Error(`Card '${this.cardId}' entered running without an activation caller.`);
    const notificationDelivery: CardNotificationDeliveryPort = {
      deliverNotificationsForInput: (inputId) => this.deliverNotificationsForInput(inputId),
    };
    const input: CardActivationInput = { activationId: this.#activationId, card: this.requireCard(), caller, notificationDelivery };
    this.#activationAbort = new AbortController();
    this.runTask(async () => {
      if (mode === 'recovery' && this.processor.recoverActive) return this.processor.recoverActive(this.processorActiveState(), input, this.#activationAbort!.signal);
      return this.processor.activate(input, this.#activationAbort!.signal);
    }, {
      on_done: (outcome) => this.commitOutcome(outcome),
      on_failed: (error) => this.commitOutcome({
        status: 'failed',
        summary: error.message,
        result: { kind: 'failed', summary: error.message },
      }),
    });
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
        cancelReason: this.cancelReason,
        active_reconstruction: this.activeReconstruction,
        activationId: this.#activationId,
      },
      updated_at: new Date().toISOString(),
    };
  }

  private commitOutcome(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): void {
    if (this.requireCard().status === 'cancelled') return;
    const stamp = new Date().toISOString();
    this.store.commitTerminalLifecyclePatch(this.cardId, cardActivationOutcomePatch(outcome, stamp));
    this.lastOutcome = outcome;
    this.activeReconstruction = null;
    this.#activationId = null;
    this.#activationAbort = null;
    this.#result?.resolve(outcome);
    this.#result = null;
    this.#activationCaller = null;
    this.sendEvent('settled');
  }

  private writeStoreStatus(status: CardStatus): void {
    const card = this.requireCard();
    if (card.status === status) return;
    if (status === 'changed' && (card.status === 'done' || card.status === 'failed' || card.status === 'blocked')) {
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
      const live = this.deps.lookup.get(childId);
      if (live) live.cancel(this.cancelReason ?? { reason: 'ancestor cancelled' });
      else this.store.setStatus(childId, 'cancelled');
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

  private processorActiveState(): string {
    return this.requireCard().type === 'project' || this.requireCard().type === 'goal' ? 'planning' : 'executing';
  }

  private persist(): void {
    this.deps.snapshots.save(this.snapshot());
  }
}

function cardLifecycleSummary(card: CardRecord): string {
  const summary = card.lifecycle?.result?.summary;
  if (typeof summary === 'string' && summary.length > 0) return summary;
  if (typeof card.status_text === 'string' && card.status_text.length > 0) return card.status_text;
  return `Card '${card.id}' finished with status '${card.status}'.`;
}

export function createProcessor(card: CardRecord, owner: CardActor): CardProcessorActor {
  if (card.type === 'project' || card.type === 'goal') {
    return new PlanningCardProcessorActor({
      projectRoot: owner.deps.projectRoot,
      cardId: card.id,
      store: owner.deps.store,
      children: { get: (childId) => owner.childCardActor(childId) },
      provider: owner.deps.provider,
      conversations: owner.deps.conversations,
      snapshots: owner.deps.snapshots,
      gate: owner.deps.gate,
      notifyCard: owner.deps.notifyCard,
      mcpManagerProvider: owner.deps.mcpManagerProvider,
      compactor: owner.deps.compactor,
      compactionConfig: owner.deps.compactionConfig,
      summarizerProvider: owner.deps.summarizerProvider,
      bufferSizeEstimator: owner.deps.bufferSizeEstimator,
      promptTemplates: owner.deps.promptTemplates,
      conversationPublisher: owner.deps.conversationPublisher,
    });
  }
  return new TerminalCardProcessorActor({
    projectRoot: owner.deps.projectRoot,
    cardId: card.id,
    provider: owner.deps.provider,
    conversations: owner.deps.conversations,
    snapshots: owner.deps.snapshots,
    processRunner: owner.deps.processRunner,
    gate: owner.deps.gate,
    store: owner.deps.store,
    mcpManagerProvider: owner.deps.mcpManagerProvider,
    compactor: owner.deps.compactor,
    compactionConfig: owner.deps.compactionConfig,
    summarizerProvider: owner.deps.summarizerProvider,
    bufferSizeEstimator: owner.deps.bufferSizeEstimator,
    promptTemplates: owner.deps.promptTemplates,
    conversationPublisher: owner.deps.conversationPublisher,
  });
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

function cardActorLifecycleState(status: CardStatus): 'parked' | 'running' | 'cancelled' {
  if (status === 'running' || status === 'cancelled') return status;
  return 'parked';
}

function compactNotificationDeliveryMarkers(markers: CardNotificationDeliveryMarker[]): void {
  if (markers.length <= MAX_NOTIFICATION_DELIVERY_MARKERS) return;
  markers.splice(0, markers.length - MAX_NOTIFICATION_DELIVERY_MARKERS);
}
