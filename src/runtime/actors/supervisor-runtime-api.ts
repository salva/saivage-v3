import { EventBus } from '../../events/index.js';
import { cardRecordSchema, type CardRecord } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { buildActorRecoveryPlan, runActorStartupRecovery, type ActorRecoveryPlan, type ActorStartupRecoveryReport, type RecoveryDiagnosticsStore } from './actor-recovery.js';
import { cardActorId, plannerActorId, parseLlmActorId } from './ids.js';
import { CardActor, cardActivationOutcomePatch, type CardActorDeps, type CardActorStorePort } from './card-actor.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { toPublicAgentPhase, toPublicCardActorState } from '../../schemas/actor-vocabulary.js';
import type { ActorSnapshotStore } from './snapshots.js';
import type { CompactorPort, LLMProviderPort } from './llm-actor.js';
import type { BufferSizeEstimator, CompactionConfig } from './compaction/compactor.js';
import type { NotifyCardResult, RuntimeApi, RuntimeCommandSource, StartProjectResult } from '../runtime-api.js';
import type { RuntimeState, RuntimeStatus } from '../../schemas/index.js';
import type { Subscription, SubscriptionOptions } from '../../events/index.js';
import type { ActorActiveWork, ActorPauseMode, ActorRuntimeReadModel } from '../../application/read-models/actor-runtime-read-model.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { CardNotification } from './card-actor.js';
import type { RuntimeStateStore } from '../state.js';
import type { ReadModelChanges } from '../../application/read-model-changes.js';
import { readRuntimeState } from '../state-api.js';
import type { ProcessRunner } from '../process-runner.js';
import { RuntimeGate } from '../runtime-gate.js';
import { buildPauseRuntimeStatePatch, buildResumeRuntimeStatePatch } from '../runtime-control-state.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import { createConversationChangePublisher } from './conversation-publisher.js';
import type { ConversationStore } from '../../persistence/conversation-store.js';
import type { AppLogStore } from '../../persistence/app-log.js';
import type { CardStore, CardStoreRepository } from '../../cards/card-store.js';
import { AutonomousCardCurrentness } from '../card-currentness.js';
import type { CompositionMutationAuthority } from '../../application/mutation-authority.js';

export interface ProjectRootCardReader {
  read(cardId: string): { id: string; type: string } | null;
}

export interface SupervisorRuntimeApiOptions {
  projectRoot: string;
  eventBus?: EventBus;
  now?: () => string;
  rootCards?: ProjectRootCardReader;
  actorStore: CardStoreRepository;
  compositionAuthority: CompositionMutationAuthority;
  provider: LLMProviderPort;
  conversations: ConversationStore;
  appLogs: AppLogStore;
  readModelChanges: ReadModelChanges;
  runtimeState: RuntimeStateStore;
  snapshots: ActorSnapshotStore;
  recoveryDiagnostics: RecoveryDiagnosticsStore;
  compactor?: CompactorPort;
  compactionConfig?: CompactionConfig;
  summarizerProvider?: LLMProviderPort;
  bufferSizeEstimator?: BufferSizeEstimator;
  processRunner: ProcessRunner;
  promptTemplates: PromptTemplateRegistry;
  runtimeGate?: RuntimeGate;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
}

export class SupervisorRuntimeApi implements RuntimeApi {
  private readonly eventBus: EventBus;
  private readonly now: () => string;
  private readonly runtimeState: RuntimeStateStore;
  private readonly runtimeGate: RuntimeGate;
  private readonly snapshots: ActorSnapshotStore;
  private started = false;
  private lifecycle: 'ready' | 'running' | 'shutting_down' | 'shutdown' = 'ready';
  private shutdownPromise: Promise<void> | null = null;
  private runGeneration = 0;
  private currentCardId: string | null = null;
  private startupRecoveryReport: ActorStartupRecoveryReport | null = null;
  private readonly cardActors = new Map<string, CardActor>();
  private readonly cardCurrentness = new AutonomousCardCurrentness();
  private readonly compositionStore: CardStore;

  constructor(private readonly options: SupervisorRuntimeApiOptions) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.now = options.now ?? (() => new Date().toISOString());
    this.runtimeState = options.runtimeState;
    this.runtimeGate = options.runtimeGate ?? new RuntimeGate();
    this.snapshots = options.snapshots;
    this.compositionStore = options.actorStore.authorize(() => options.compositionAuthority);
  }

  async start(): Promise<void> {
    if (this.lifecycle === 'shutting_down' || this.lifecycle === 'shutdown') throw new Error('Cannot start a shutdown runtime.');
    if (this.started) return;

    const rootError = this.tryReadRootCardRecord();
    if (rootError !== null) {
      throw new Error(`Root card record '${PROJECT_CARD_ID}' is corrupt or missing; repair it and restart. (${rootError.message})`);
    }

    this.runtimeGate.close();
    const recoveryPlan = buildActorRecoveryPlan(this.options.projectRoot, this.compositionStore);
    this.startupRecoveryReport = runActorStartupRecovery(recoveryPlan, {
      projectRoot: this.options.projectRoot,
      store: this.compositionStore,
      generatedAt: this.now(),
      conversations: this.options.conversations,
      mutationAuthority: this.options.compositionAuthority,
      snapshots: this.snapshots,
      recoveryDiagnostics: this.options.recoveryDiagnostics,
    });
    if (this.hasRunningRecoveryWork(recoveryPlan)) {
      this.cardCurrentness.startRoot(PROJECT_CARD_ID);
      this.constructRunningCardActors(recoveryPlan);
      this.recoverRootCard();
      this.runtimeState.patch(this.options.compositionAuthority, { ...buildPauseRuntimeStatePatch(), active_card_run: null, updated_at: this.now() }, false);
    } else {
      this.reconcileStaleRootRuns();
      this.runtimeGate.setOpen(readRuntimeState(this.options.projectRoot)?.status !== 'paused');
    }
    this.started = true;
    this.lifecycle = 'running';
  }

  getStartupRecoveryReport(): ActorStartupRecoveryReport | null {
    return this.startupRecoveryReport;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.lifecycle = 'shutting_down';
    this.runtimeGate.close();
    ++this.runGeneration;
    this.cardCurrentness.clear();
    let resolveShutdown!: () => void;
    let rejectShutdown!: (error: unknown) => void;
    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    void this.shutdownOnce().then(resolveShutdown, rejectShutdown);
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    for (const actor of this.cardActors.values()) actor.cancel({ reason: 'runtime shutdown' }, this.compositionStore);
    const processReport = await this.options.processRunner.terminateScopeTree({ rootScope: this.options.processRunner.runtimeRootScope, categories: ['runtime_card'], reason: 'runtime shutdown', graceMs: 5000 });
    if (processReport.failed.length > 0) throw new Error(processReport.failed.map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`).join('; '));
    this.cardActors.clear();
    this.currentCardId = null;
    this.started = false;
    this.runtimeState.patch(this.options.compositionAuthority, { status: 'stopped', active_card_run: null, updated_at: this.now() }, false);
    this.lifecycle = 'shutdown';
  }

  pause(): void {
    if (this.lifecycle === 'shutting_down' || this.lifecycle === 'shutdown') throw new Error('Cannot pause a shutdown runtime.');
    if (!this.started) throw new Error('Cannot pause runtime before it is started.');
    const status = this.runtimeStatus() ?? 'stopped';
    if (status !== 'running') throw new Error(`Cannot pause runtime from '${status}'.`);
    this.runtimeGate.close();
    this.runtimeState.patch(this.options.compositionAuthority, { ...buildPauseRuntimeStatePatch(), active_card_run: null, updated_at: this.now() });
  }

  resume(): void {
    if (this.lifecycle === 'shutting_down' || this.lifecycle === 'shutdown') throw new Error('Cannot resume a shutdown runtime.');
    if (!this.started) throw new Error('Cannot resume runtime before it is started.');
    const status = this.runtimeStatus() ?? 'stopped';
    if (status !== 'paused') throw new Error(`Cannot resume runtime from '${status}'.`);
    const activeRunStartedAt = readRuntimeState(this.options.projectRoot)?.active_card_run?.started_at ?? this.now();
    this.runtimeState.patch(this.options.compositionAuthority, { ...buildResumeRuntimeStatePatch(readRuntimeState(this.options.projectRoot)), status: 'running', active_card_run: this.activeCardRun(activeRunStartedAt), updated_at: this.now() });
    this.runtimeGate.open();
  }

  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult {
    if (this.lifecycle === 'shutting_down' || this.lifecycle === 'shutdown') {
      throw new Error('Cannot notify a shutdown runtime.');
    }
    const actor = this.cardActors.get(cardId);
    if (actor) {
      actor.enqueueNotification(notification);
      return { ok: true };
    }
    const card = this.options.actorStore.read(cardId);
    if (!card) return { ok: false, reason: 'missing_card', cardId };
    this.snapshots.appendNotification(this.compositionStore.currentMutationAuthority(), cardActorId(cardId), notification);
    if (card.status === 'done' || card.status === 'failed') {
      // Notifications do not mutate card lifecycle; the authorized caller owns any change propagation.
    }
    return { ok: true };
  }

  async startProject(_source: RuntimeCommandSource = 'operator'): Promise<StartProjectResult> {
    if (this.isShutdownLifecycle()) return this.rejectStart('Cannot start runtime: runtime is shutting down.');
    await this.start();
    if (this.isShutdownLifecycle()) return this.rejectStart('Cannot start runtime: runtime is shutting down.');
    const rejection = this.startProjectRejection(_source);
    if (rejection) return rejection;

    const startedAt = this.now();
    this.cardCurrentness.startRoot(PROJECT_CARD_ID);
    this.runtimeGate.open();
    this.currentCardId = PROJECT_CARD_ID;
    const runtime = this.runtimeState.replace(this.options.compositionAuthority, { ...(readRuntimeState(this.options.projectRoot) ?? this.activeRuntimeState(startedAt)), status: 'running', active_card_run: this.activeCardRun(startedAt), updated_at: startedAt });
    const generation = ++this.runGeneration;
    void this.runRootProject(startedAt, generation);
    return { runtime, status: runtime.status, started: true, stopped: false };
  }

  subscribe(options: SubscriptionOptions): Subscription {
    return this.eventBus.subscribe(options);
  }

  getStatus(): { status: RuntimeStatus; currentCardId: string | null; goalCount: number; lastTickAt: string | null } {
    if (!this.started) {
      return { status: 'stopped', currentCardId: null, goalCount: 0, lastTickAt: null };
    }
    const status = this.runtimeStatus();
    return {
      status: status ?? 'stopped',
      currentCardId: this.currentCardId,
      goalCount: this.currentCardId ? 1 : 0,
      lastTickAt: null,
    };
  }

  getActorRuntimeReadModel(): ActorRuntimeReadModel {
    const cards = [...this.cardActors.values()].flatMap((actor) => {
      const card = this.options.actorStore.read(actor.cardId);
      return card ? [{ cardId: actor.cardId, actorState: toPublicCardActorState(card.status) }] : [];
    }).sort((a, b) => a.cardId.localeCompare(b.cardId));
    const agents = [...this.cardActors.values()].flatMap((cardActor) => {
      const processor = cardActor.processor;
      if (!(processor instanceof BaseMainLLMCardProcessorActor)) return [];
      return processor.listLlmActors().map((agent) => {
        const identity = parseLlmActorId(agent.agentId);
        return { agentId: agent.agentId, role: identity.role, cardId: identity.cardId, phase: toPublicAgentPhase(agent.state()) };
      });
    }).sort((a, b) => a.agentId.localeCompare(b.agentId));
    return {
      pauseMode: this.actorPauseMode(),
      activeWork: this.actorActiveWork(),
      cards,
      agents,
      diagnostics: [],
      recovery: this.startupRecoveryReport?.outstanding
        ? { generated_at: this.startupRecoveryReport.outstanding.generated_at, diagnostics: this.startupRecoveryReport.outstanding.diagnostics, actions: this.startupRecoveryReport.outstanding.actions }
        : null,
    };
  }

  private startProjectRejection(_source: RuntimeCommandSource): StartProjectResult | null {
    if (this.runtimeStatus() === 'running') return this.rejectStart('Cannot start runtime: project execution is already running.');
    return null;
  }

  private rejectStart(message: string): StartProjectResult {
    const runtime = readRuntimeState(this.options.projectRoot);
    return { runtime, status: runtime?.status ?? 'stopped', started: false, stopped: runtime?.status !== 'running', error: message };
  }

  private activeCardRun(startedAt: string): RuntimeState['active_card_run'] {
    return {
      card_id: PROJECT_CARD_ID,
      card_type: 'project',
      ownership: { kind: 'direct', source: 'project_root' },
      runtime_status: 'running',
      phase: 'planner',
      caller_session_id: null,
      caller_tool_call_id: null,
      planner_session_id: plannerActorId(PROJECT_CARD_ID),
      executor_session_id: null,
      reviewer_session_id: null,
      correction_attempts: 0,
      started_at: startedAt,
      last_turn_at: startedAt,
    };
  }

  private async runRootProject(startedAt: string, generation: number): Promise<void> {
    try {
      const actor = this.cardActor(PROJECT_CARD_ID);
      if (generation !== this.runGeneration || this.lifecycle !== 'running') return;
      const outcome = await actor.activate({ kind: 'root' });
      if (outcome.status !== 'cancelled') {
        const rootStore = this.options.actorStore.authorize(() => this.cardCurrentness.forCard(PROJECT_CARD_ID).current());
        rootStore.commitTerminalLifecyclePatch(PROJECT_CARD_ID, cardActivationOutcomePatch(outcome, this.now()));
      }
    } catch (err) {
      if (generation !== this.runGeneration || this.lifecycle !== 'running') return;
      this.cardCurrentness.clear();
      const at = this.now();
      const current = readRuntimeState(this.options.projectRoot) ?? this.activeRuntimeState(startedAt);
      this.runtimeState.replace(this.options.compositionAuthority, { ...current, status: 'error', active_card_run: null, updated_at: at });
    } finally {
      if (generation !== this.runGeneration || this.lifecycle !== 'running') return;
      this.currentCardId = null;
      const current = readRuntimeState(this.options.projectRoot);
      if (current?.status === 'running') this.runtimeState.patch(this.options.compositionAuthority, { status: 'stopped', active_card_run: null, updated_at: this.now() });
    }
  }

  private reconcileStaleRootRuns(): void {
    const state = readRuntimeState(this.options.projectRoot);
    if (!state) return;
    const at = this.now();
    if (state.status !== 'stopped' || state.active_card_run) {
      this.runtimeState.patch(this.options.compositionAuthority, { status: 'stopped', active_card_run: null, updated_at: at }, false);
    }
  }

  private activeRuntimeState(nowIso: string): RuntimeState {
    return { status: 'running', project_id: 'project', pid: process.pid, started_at: nowIso, active_card_run: this.activeCardRun(nowIso), updated_at: nowIso, last_tick_at: null };
  }

  private cardActor(cardId: string): CardActor {
    const existing = this.cardActors.get(cardId);
    if (existing) return existing;
    const card = this.options.actorStore.read(cardId);
    if (!card) throw new Error(`Card '${cardId}' not found.`);
    return CardActor.fromCard({ card, deps: this.cardActorDeps() });
  }

  private constructRunningCardActors(plan: ActorRecoveryPlan): void {
    for (const card of plan.cards) {
      const record = this.options.actorStore.read(card.cardId);
      if (record?.status !== 'running') continue;
      if (this.cardActors.has(card.cardId)) continue;
      CardActor.fromCard({ card: record, deps: this.cardActorDeps(), deferRunningRecovery: true });
    }
  }

  private recoverRootCard(): void {
    this.cardActors.get(PROJECT_CARD_ID)?.recoverCurrentCardState();
  }

  private hasRunningRecoveryWork(plan: ActorRecoveryPlan): boolean {
    return plan.cards.some((card) => this.options.actorStore.read(card.cardId)?.status === 'running' && card.activeReconstruction !== null);
  }

  private tryReadRootCardRecord(): Error | null {
    let rootRecord: CardRecord | null;
    try {
      rootRecord = this.options.actorStore.read(PROJECT_CARD_ID);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    if (rootRecord === null) return new Error('Root card record is missing.');
    const parsed = cardRecordSchema.safeParse(rootRecord);
    if (!parsed.success) return new Error(`Root card record failed schema validation: ${parsed.error.message}`);
    return null;
  }

  private cardActorDeps(): CardActorDeps {
    return {
      projectRoot: this.options.projectRoot,
      storeForCard: (cardId) => this.options.actorStore.authorize(() => this.cardCurrentness.forCard(cardId).current()),
      currentness: this.cardCurrentness,
      provider: this.options.provider,
      compactor: this.options.compactor,
      compactionConfig: this.options.compactionConfig,
      summarizerProvider: this.options.summarizerProvider,
      bufferSizeEstimator: this.options.bufferSizeEstimator,
      gate: this.runtimeGate,
      processRunner: this.options.processRunner,
      promptTemplates: this.options.promptTemplates,
      mcpManagerProvider: this.options.mcpManagerProvider,
      notifyCard: (targetCardId, notification) => this.notifyCard(targetCardId, notification),
      lookup: this.cardActors,
      conversationPublisher: createConversationChangePublisher(this.eventBus),
      conversations: this.options.conversations,
      appLogs: this.options.appLogs,
      snapshots: this.snapshots,
    };
  }

  private actorPauseMode(): ActorPauseMode {
    const status = this.runtimeStatus();
    if (status === 'running') return 'running';
    if (status === 'paused') return 'paused';
    if (status === 'error') return 'unknown';
    return 'idle';
  }

  private actorActiveWork(): ActorActiveWork {
    return 'none';
  }

  private runtimeStatus(): RuntimeStatus | null {
    return readRuntimeState(this.options.projectRoot)?.status ?? null;
  }

  private isShutdownLifecycle(): boolean {
    return this.lifecycle === 'shutting_down' || this.lifecycle === 'shutdown';
  }
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): RuntimeApi {
  return new SupervisorRuntimeApi(options);
}
