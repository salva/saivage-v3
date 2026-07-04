import { EventBus } from '../../events/index.js';
import { createActionableErrorEnvelope } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { buildActorRecoveryPlan, runActorStartupRecovery, type ActorStartupRecoveryReport } from './actor-recovery.js';
import { cardActorId, plannerActorId, parseLlmActorId } from './ids.js';
import { RuntimeSupervisorActor } from './runtime-supervisor.js';
import { CardActor, type CardActivationOutcome, type CardActorStorePort } from './card-actor.js';
import { PlanningCardProcessorActor, type PlannerChildActorPort } from './planning-card-processor-actor.js';
import { TerminalCardProcessorActor } from './terminal-card-processor-actor.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { toPublicAgentPhase, toPublicCardActorState } from './actor-vocabulary.js';
import { appendNotificationToActorSnapshot } from './snapshots.js';
import type { LLMProviderPort } from './llm-actor.js';
import type { NotifyCardResult, RuntimeApi, RuntimeCommandSource, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import type { CardRecord, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState, RuntimeStatus } from '../../schemas/index.js';
import type { Subscription, SubscriptionOptions } from '../../events/index.js';
import type { ActorActiveWork, ActorPauseMode, ActorRuntimeReadModel } from '../../application/read-models/actor-runtime-read-model.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { CardNotification } from './card-actor.js';
import { createRuntimeStateMutationPort, type RuntimeStateMutationPort } from '../mutations.js';
import { readRuntimeState } from '../state-api.js';

type RuntimeRunAppendInput = Omit<RuntimeRunRecord, 'run_id' | 'started_at' | 'updated_at'> & { run_id?: string; started_at?: string; updated_at?: string };

export interface ProjectRootCardReader {
  read(cardId: string): { id: string; type: string } | null;
}

export interface SupervisorRuntimeApiOptions {
  projectRoot: string;
  eventBus?: EventBus;
  now?: () => string;
  rootCards?: ProjectRootCardReader;
  actorStore: CardActorStorePort;
  provider: LLMProviderPort;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
}

export class SupervisorRuntimeApi implements RuntimeApi {
  private readonly supervisor = new RuntimeSupervisorActor();
  private readonly eventBus: EventBus;
  private readonly now: () => string;
  private readonly runtimeState: RuntimeStateMutationPort;
  private started = false;
  private commandCounter = 0;
  private currentCardId: string | null = null;
  private activeRun: RuntimeRunRecord | null = null;
  private startupRecoveryReport: ActorStartupRecoveryReport | null = null;
  private readonly cardActors = new Map<string, CardActor>();

  constructor(private readonly options: SupervisorRuntimeApiOptions) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.now = options.now ?? (() => new Date().toISOString());
    this.runtimeState = createRuntimeStateMutationPort(options.projectRoot);
  }

  async start(): Promise<void> {
    if (this.started) return;
    const recoveryPlan = buildActorRecoveryPlan(this.options.projectRoot, this.options.actorStore);
    this.startupRecoveryReport = runActorStartupRecovery(recoveryPlan, {
      projectRoot: this.options.projectRoot,
      store: this.options.actorStore,
      generatedAt: this.now(),
      makePlanningProcessor: (cardId) => new PlanningCardProcessorActor({ projectRoot: this.options.projectRoot, cardId, store: this.options.actorStore, children: this.childrenPort(), provider: this.options.provider, admission: this, notifyCard: (targetCardId, notification) => this.notifyCard(targetCardId, notification), mcpManagerProvider: this.options.mcpManagerProvider }),
      makeTerminalProcessor: (cardId) => new TerminalCardProcessorActor({ projectRoot: this.options.projectRoot, cardId, provider: this.options.provider, admission: this, store: this.options.actorStore, mcpManagerProvider: this.options.mcpManagerProvider }),
    });
    this.reconcileStaleRootRuns();
    this.supervisor.start();
    this.supervisor.initialize(this.options.projectRoot);
    this.started = true;
  }

  getStartupRecoveryReport(): ActorStartupRecoveryReport | null {
    return this.startupRecoveryReport;
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.shutdownOwnedProcesses('runtime shutdown');
    this.supervisor.shutdown();
    this.started = false;
    this.currentCardId = null;
    this.activeRun = null;
  }

  pause(): void {
    if (!this.started) return;
    this.supervisor.pause();
  }

  resume(): void {
    if (!this.started) return;
    if (!this.currentCardId) return;
    this.supervisor.run();
  }

  notifyCard(cardId: string, notification: CardNotification): NotifyCardResult {
    const actor = this.cardActors.get(cardId);
    if (actor) {
      actor.enqueueNotification(notification);
      return { ok: true };
    }
    const card = this.options.actorStore.read(cardId);
    if (!card) return { ok: false, reason: 'missing_card', cardId };
    appendNotificationToActorSnapshot(this.options.projectRoot, cardActorId(cardId), notification);
    if (card.status === 'done' || card.status === 'failed' || card.status === 'needs_verification') {
      this.options.actorStore.commitTerminalLifecyclePatch(cardId, {
        status: 'changed',
        lifecycle: { status: 'changed', result: card.lifecycle.result, error: card.lifecycle.error, completed_at: null },
      });
    }
    return { ok: true };
  }

  async startProject(source: RuntimeCommandSource = 'operator'): Promise<StartProjectResult> {
    await this.start();
    const rejection = this.startProjectRejection(source);
    if (rejection) return rejection;

    const command = this.runtimeState.apply({ kind: 'appendRuntimeCommand', commandKind: 'start_project', source });
    const startedAt = this.now();
    this.supervisor.run();
    this.currentCardId = PROJECT_CARD_ID;
    const run = this.runtimeState.apply({ kind: 'appendRuntimeRun', run: this.runRecordInput(command.command_id, startedAt, null, 'pending', 'running') });
    this.activeRun = run;
    this.runtimeState.apply({ kind: 'patchRuntimeState', patch: { status: 'running', active_card_run: this.activeCardRun(startedAt), updated_at: startedAt } });
    void this.runRootProject(command, run);
    return {
      success: true,
      command,
      run,
    };
  }

  async stopProject(source: RuntimeCommandSource = 'operator'): Promise<StopProjectResult> {
    await this.start();
    const command = this.command('stop_project', 'completed', source);
    const stoppedAt = this.now();
    this.cardActors.get(PROJECT_CARD_ID)?.cancel({ reason: 'runtime_project_cancelled', cancelled_at: stoppedAt });
    this.shutdownOwnedProcesses('runtime_project_cancelled');
    this.supervisor.cancelProject();
    const run = this.activeRun
      ? this.runtimeState.apply({
          kind: 'updateRuntimeRun',
          runId: this.activeRun.run_id,
          updates: {
            phase: 'cancelled',
            runtime_status: 'cancelled',
            finished_at: stoppedAt,
            outcome: { kind: 'completed', result: 'cancelled', finished_at: stoppedAt },
          },
        }) ?? undefined
      : undefined;
    this.currentCardId = null;
    this.activeRun = null;
    this.runtimeState.apply({ kind: 'patchRuntimeState', patch: { status: 'stopped', active_card_run: null, updated_at: stoppedAt } });
    return {
      success: true,
      command,
      run,
    };
  }

  subscribe(options: SubscriptionOptions): Subscription {
    return this.eventBus.subscribe(options);
  }

  getStatus(): { status: RuntimeStatus; currentCardId: string | null; goalCount: number; lastTickAt: string | null } {
    if (!this.started) {
      return { status: 'stopped', currentCardId: null, goalCount: 0, lastTickAt: null };
    }
    const mode = this.supervisor.mode;
    return {
      status: mode === 'paused' ? 'paused' : mode === 'running' ? 'running' : 'stopped',
      currentCardId: this.currentCardId,
      goalCount: this.currentCardId ? 1 : 0,
      lastTickAt: null,
    };
  }

  getActorRuntimeReadModel(): ActorRuntimeReadModel {
    const cards = [...this.cardActors.values()].map((actor) => ({
      cardId: actor.cardId,
      actorState: toPublicCardActorState(actor.state()),
    })).sort((a, b) => a.cardId.localeCompare(b.cardId));
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

  requestProviderCall(callId: string): boolean {
    return this.supervisor.requestProviderCall(callId);
  }

  releaseProviderCall(callId: string): void {
    this.supervisor.releaseProviderCall(callId);
  }

  private command(command: RuntimeCommandRecord['command'], status: RuntimeCommandRecord['status'], source: RuntimeCommandSource): RuntimeCommandRecord {
    this.commandCounter++;
    const at = this.now();
    return {
      command_id: `runtime-command-${this.commandCounter}`,
      command,
      status,
      requested_at: at,
      completed_at: at,
      source,
      error: null,
    };
  }

  private startProjectRejection(source: RuntimeCommandSource): StartProjectResult | null {
    if (this.supervisor.mode === 'running') return this.rejectStart(source, 'runtime_already_running', 'Cannot start runtime: project execution is already running.', 'Wait for the active run to finish or stop it before starting again.');
    if (this.supervisor.mode === 'shutting_down') return this.rejectStart(source, 'runtime_stopping', 'Cannot start runtime: shutdown is in progress.', 'Wait for shutdown to complete before starting again.');
    if (this.activeRun?.runtime_status === 'running') return this.rejectStart(source, 'runtime_run_already_active', `Cannot start runtime: run '${this.activeRun.run_id}' is already active.`, 'Wait for the active run to finish or stop it before starting again.');
    return null;
  }

  private rejectStart(source: RuntimeCommandSource, code: string, message: string, nextAction: string): StartProjectResult {
    const command = this.runtimeState.apply({ kind: 'appendRuntimeCommand', commandKind: 'start_project', source });
    const error = createActionableErrorEnvelope({
      code,
      message,
      currentState: { mode: this.supervisor.mode, work: this.supervisor.work, activeRunId: this.activeRun?.run_id ?? null },
      nextAction,
      docsRef: 'docs/architecture/micro-actor-runtime-design.md',
      runId: this.activeRun?.run_id ?? null,
      cardId: PROJECT_CARD_ID,
    });
    const rejected = this.runtimeState.apply({ kind: 'rejectRuntimeCommand', command, error, at: this.now() });
    return { success: false, command: rejected, error };
  }

  private runRecordInput(commandId: string, startedAt: string, finishedAt: string | null, phase: RuntimeRunRecord['phase'], runtimeStatus: RuntimeRunRecord['runtime_status']): RuntimeRunAppendInput {
    return {
      kind: 'root',
      card_id: PROJECT_CARD_ID,
      ownership: { kind: 'direct', source: 'project_root' },
      parent_run_id: null,
      command_id: commandId,
      activation_id: null,
      phase,
      runtime_status: runtimeStatus,
      session_id: plannerActorId(PROJECT_CARD_ID),
      started_at: startedAt,
      updated_at: finishedAt ?? startedAt,
      finished_at: finishedAt,
      outcome: null,
    };
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

  private async runRootProject(_command: RuntimeCommandRecord, run: RuntimeRunRecord): Promise<void> {
    try {
      const actor = this.cardActor(PROJECT_CARD_ID);
      const outcome = await actor.activate({ kind: 'root' });
      this.finalizePersistedRootRun(run, outcome, this.now());
    } catch (err) {
      try {
        this.failPersistedRootRun(run, err, this.now());
      } catch {
        // Runtime command dispatch must never surface as an unhandled rejection.
      }
    } finally {
      if (this.activeRun?.run_id === run.run_id) {
        const shouldCancel = this.activeRun.phase === 'cancelled';
        this.currentCardId = null;
        this.activeRun = null;
        this.runtimeState.apply({ kind: 'patchRuntimeState', patch: { status: 'stopped', active_card_run: null, updated_at: this.now() } });
        if (shouldCancel) this.supervisor.cancelProject();
        else this.supervisor.settleProject();
      }
    }
  }

  private finalizePersistedRootRun(run: RuntimeRunRecord, outcome: CardActivationOutcome, finishedAt: string): RuntimeRunRecord | null {
    const existing = this.persistedRun(run.run_id);
    if (existing && this.isTerminalRun(existing)) return existing;
    const updates = this.finalRootRunUpdates(run, outcome, finishedAt);
    const updated = this.runtimeState.apply({ kind: 'updateRuntimeRun', runId: run.run_id, updates });
    if (this.activeRun?.run_id === run.run_id && updated) this.activeRun = updated;
    return updated;
  }

  private failPersistedRootRun(run: RuntimeRunRecord, err: unknown, finishedAt: string): RuntimeRunRecord | null {
    const existing = this.persistedRun(run.run_id);
    if (existing && this.isTerminalRun(existing)) return existing;
    const error = err instanceof Error ? err.message : String(err);
    const updated = this.runtimeState.apply({
      kind: 'updateRuntimeRun',
      runId: run.run_id,
      updates: { phase: 'failed', runtime_status: 'stopped', finished_at: finishedAt, outcome: { kind: 'completed', result: 'failed', error: error || 'Runtime root execution failed.', finished_at: finishedAt } },
    });
    if (this.activeRun?.run_id === run.run_id && updated) this.activeRun = updated;
    return updated;
  }

  private finalRootRunUpdates(_run: RuntimeRunRecord, outcome: CardActivationOutcome, finishedAt: string): Partial<RuntimeRunRecord> {
    if (outcome.status === 'done') return { phase: 'completed', runtime_status: 'stopped', finished_at: finishedAt, outcome: { kind: 'completed', result: 'done', finished_at: finishedAt } };
    if (outcome.status === 'failed') return { phase: 'failed', runtime_status: 'stopped', finished_at: finishedAt, outcome: { kind: 'completed', result: 'failed', error: outcome.summary, finished_at: finishedAt } };
    if (outcome.status === 'cancelled') return { phase: 'cancelled', runtime_status: 'cancelled', finished_at: finishedAt, outcome: { kind: 'completed', result: 'cancelled', finished_at: finishedAt } };
    return { phase: 'blocked', runtime_status: 'stopped', finished_at: null, outcome: { kind: 'blocked', error: outcome.summary } };
  }

  private persistedRun(runId: string): RuntimeRunRecord | null {
    return readRuntimeState(this.options.projectRoot)?.runtime_runs.find((run) => run.run_id === runId) ?? null;
  }

  private isTerminalRun(run: RuntimeRunRecord): boolean {
    return run.runtime_status !== 'running' || ['completed', 'failed', 'blocked', 'cancelled', 'stopped', 'needs_verification'].includes(run.phase);
  }

  private reconcileStaleRootRuns(): void {
    const state = readRuntimeState(this.options.projectRoot);
    if (!state) return;
    const at = this.now();
    for (const run of state.runtime_runs) {
      if (run.kind !== 'root' || run.runtime_status !== 'running') continue;
      this.runtimeState.apply({
        kind: 'updateRuntimeRun',
        runId: run.run_id,
        updates: { phase: 'failed', runtime_status: 'stopped', finished_at: at, outcome: { kind: 'completed', result: 'failed', error: 'Runtime process restarted before this run completed.', finished_at: at } },
      });
    }
    if (state.runtime_runs.some((run) => run.kind === 'root' && run.runtime_status === 'running') || state.status !== 'stopped' || state.active_card_run) {
      this.runtimeState.apply({ kind: 'patchRuntimeState', patch: { status: 'stopped', active_card_run: null, updated_at: at } });
    }
  }

  private cardActor(cardId: string): CardActor {
    const existing = this.cardActors.get(cardId);
    if (existing) return existing;
    const card = this.options.actorStore.read(cardId);
    if (!card) throw new Error(`Card '${cardId}' not found.`);
    const actor = CardActor.fromCard({ projectRoot: this.options.projectRoot, card, store: this.options.actorStore, processor: this.processorFor(card) });
    this.cardActors.set(cardId, actor);
    return actor;
  }

  private processorFor(card: CardRecord) {
    if (card.type === 'project') {
      const processor = new PlanningCardProcessorActor({ projectRoot: this.options.projectRoot, cardId: card.id, store: this.options.actorStore, children: this.childrenPort(), provider: this.options.provider, admission: this, notifyCard: (targetCardId, notification) => this.notifyCard(targetCardId, notification), mcpManagerProvider: this.options.mcpManagerProvider });
      processor.start();
      return processor;
    }
    if (card.type === 'goal') {
      const processor = new PlanningCardProcessorActor({ projectRoot: this.options.projectRoot, cardId: card.id, store: this.options.actorStore, children: this.childrenPort(), provider: this.options.provider, admission: this, notifyCard: (targetCardId, notification) => this.notifyCard(targetCardId, notification), mcpManagerProvider: this.options.mcpManagerProvider });
      processor.start();
      return processor;
    }
    const processor = new TerminalCardProcessorActor({ projectRoot: this.options.projectRoot, cardId: card.id, provider: this.options.provider, admission: this, store: this.options.actorStore, mcpManagerProvider: this.options.mcpManagerProvider });
    processor.start();
    return processor;
  }

  private childrenPort(): PlannerChildActorPort {
    return { get: (cardId) => this.cardActor(cardId) };
  }

  private actorPauseMode(): ActorPauseMode {
    const mode = this.supervisor.mode;
    if (mode === 'paused') return 'paused';
    if (mode === 'shutting_down') return 'stopping';
    return mode === 'running' ? 'running' : 'idle';
  }

  private actorActiveWork(): ActorActiveWork {
    const work = this.supervisor.work;
    if (work === 'model_invocation_active') return 'model_invocation';
    if (work === 'shutdown_active') return 'shutdown';
    return 'none';
  }

  private shutdownOwnedProcesses(reason: string): void {
    for (const actor of this.cardActors.values()) {
      if (actor.processor instanceof TerminalCardProcessorActor) actor.processor.shutdownOwnedProcesses(reason);
    }
  }
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): RuntimeApi {
  return new SupervisorRuntimeApi(options);
}
