import { EventBus } from '../../events/index.js';
import { createActionableErrorEnvelope } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { buildActorRecoveryPlan, runActorStartupRecovery, type ActorStartupRecoveryReport } from './actor-recovery.js';
import { plannerActorId } from './ids.js';
import { RuntimeSupervisorActor } from './runtime-supervisor.js';
import { CardActor, type CardActivationOutcome, type CardActorStorePort } from './card-actor.js';
import { PlanningCardProcessorActor, type PlannerChildActorPort } from './planning-card-processor-actor.js';
import { TerminalCardProcessorActor } from './terminal-card-processor-actor.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import { toPublicAgentPhase, toPublicCardActorState } from './actor-vocabulary.js';
import { parseLlmActorId } from './ids.js';
import type { LLMProviderPort } from './llm-actor.js';
import type { RuntimeApi, RuntimeCommandSource, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import type { CardRecord, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState, RuntimeStatus } from '../../schemas/index.js';
import type { SessionActivity } from '../session-stamper.js';
import type { Subscription, SubscriptionOptions } from '../../events/index.js';
import type { ActorActiveWork, ActorPauseMode, ActorRuntimeReadModel } from '../../application/read-models/actor-runtime-read-model.js';

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
}

export class SupervisorRuntimeApi implements RuntimeApi {
  private readonly supervisor = new RuntimeSupervisorActor();
  private readonly eventBus: EventBus;
  private readonly now: () => string;
  private started = false;
  private commandCounter = 0;
  private runCounter = 0;
  private currentCardId: string | null = null;
  private activeRun: RuntimeRunRecord | null = null;
  private startupRecoveryReport: ActorStartupRecoveryReport | null = null;
  private readonly cardActors = new Map<string, CardActor>();

  constructor(private readonly options: SupervisorRuntimeApiOptions) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(): Promise<void> {
    if (this.started) return;
    const recoveryPlan = buildActorRecoveryPlan(this.options.projectRoot, this.options.actorStore);
    this.startupRecoveryReport = runActorStartupRecovery(recoveryPlan, {
      projectRoot: this.options.projectRoot,
      store: this.options.actorStore,
      generatedAt: this.now(),
      makePlanningProcessor: (cardId) => new PlanningCardProcessorActor({ projectRoot: this.options.projectRoot, cardId, store: this.options.actorStore, children: this.childrenPort(), provider: this.options.provider, admission: this }),
      makeTerminalProcessor: (cardId) => new TerminalCardProcessorActor({ projectRoot: this.options.projectRoot, cardId, provider: this.options.provider, admission: this, store: this.options.actorStore }),
    });
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

  async startProject(source: RuntimeCommandSource = 'operator'): Promise<StartProjectResult> {
    await this.start();
    const rootCard = this.options.rootCards?.read(PROJECT_CARD_ID) ?? this.options.actorStore.read(PROJECT_CARD_ID);
    if (!rootCard) {
      const command = this.command('start_project', 'rejected', source);
      const error = createActionableErrorEnvelope({
        code: 'runtime_project_card_missing',
        message: `Cannot start runtime: project card '${PROJECT_CARD_ID}' was not found.`,
        cardId: PROJECT_CARD_ID,
        currentState: { mode: this.supervisor.mode, work: this.supervisor.work },
        nextAction: `Create or repair the canonical project card '${PROJECT_CARD_ID}' before starting runtime execution.`,
        docsRef: 'docs/architecture/micro-actor-runtime-design.md',
      });
      return { success: false, command: { ...command, error }, error };
    }

    const command = this.command('start_project', 'completed', source);
    const startedAt = this.now();
    this.supervisor.run();
    this.currentCardId = PROJECT_CARD_ID;
    this.activeRun = this.runRecord(command.command_id, startedAt, null, 'pending', 'running');
    const actor = this.cardActor(PROJECT_CARD_ID);
    const outcome = await actor.activate({ kind: 'root' });
    const finishedAt = this.now();
    this.activeRun = this.finalizeRootRun(outcome, finishedAt);
    this.currentCardId = null;
    if (outcome.status === 'cancelled') this.supervisor.cancelProject();
    else this.supervisor.settleProject();
    return {
      success: true,
      command,
      intent: { status: 'running', updated_at: startedAt, source_command_id: command.command_id, reason: null },
      run: this.activeRun,
    };
  }

  async stopProject(source: RuntimeCommandSource = 'operator'): Promise<StopProjectResult> {
    await this.start();
    const command = this.command('stop_project', 'completed', source);
    const stoppedAt = this.now();
    this.cardActors.get(PROJECT_CARD_ID)?.cancel({ reason: 'runtime_project_cancelled', cancelled_at: stoppedAt });
    this.supervisor.cancelProject();
    const run = this.activeRun
      ? {
          ...this.activeRun,
          phase: 'cancelled' as const,
          runtime_status: 'cancelled' as const,
          updated_at: stoppedAt,
          finished_at: stoppedAt,
          outcome: { kind: 'completed' as const, result: 'cancelled' as const, finished_at: stoppedAt },
        }
      : undefined;
    this.currentCardId = null;
    this.activeRun = null;
    return {
      success: true,
      command,
      intent: { status: 'stopped', updated_at: stoppedAt, source_command_id: command.command_id, reason: 'runtime_project_cancelled' },
      run,
    };
  }

  subscribe(options: SubscriptionOptions): Subscription {
    return this.eventBus.subscribe(options);
  }

  getStatus(): { status: RuntimeStatus; paused: boolean; currentCardId: string | null; goalCount: number; lastTickAt: string | null } {
    if (!this.started) {
      return { status: 'idle', paused: false, currentCardId: null, goalCount: 0, lastTickAt: null };
    }
    const mode = this.supervisor.mode;
    return {
      status: mode === 'paused' ? 'paused' : mode === 'running' ? 'running' : 'idle',
      paused: mode === 'paused',
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

  getActivityStatus(_sessionId: string): SessionActivity {
    return { status: 'idle', pending_calls: [], updated_at: this.now() };
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

  private runRecord(commandId: string, startedAt: string, finishedAt: string | null, phase: RuntimeRunRecord['phase'], runtimeStatus: RuntimeRunRecord['runtime_status']): RuntimeRunRecord {
    this.runCounter++;
    return {
      run_id: `runtime-run-${this.runCounter}`,
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

  private finalizeRootRun(outcome: CardActivationOutcome, finishedAt: string): RuntimeRunRecord {
    if (!this.activeRun) throw new Error('Cannot finalize root run before active run is created.');
    if (outcome.status === 'done') {
      return {
        ...this.activeRun,
        phase: 'completed',
        runtime_status: 'idle',
        updated_at: finishedAt,
        finished_at: finishedAt,
        outcome: { kind: 'completed', result: 'done', finished_at: finishedAt },
      };
    }
    if (outcome.status === 'failed') {
      return {
        ...this.activeRun,
        phase: 'failed',
        runtime_status: 'stopped',
        updated_at: finishedAt,
        finished_at: finishedAt,
        outcome: { kind: 'completed', result: 'failed', error: outcome.summary, finished_at: finishedAt },
      };
    }
    if (outcome.status === 'cancelled') {
      return {
        ...this.activeRun,
        phase: 'cancelled',
        runtime_status: 'cancelled',
        updated_at: finishedAt,
        finished_at: finishedAt,
        outcome: { kind: 'completed', result: 'cancelled', finished_at: finishedAt },
      };
    }
    return {
      ...this.activeRun,
      phase: 'blocked',
      runtime_status: 'stopped',
      updated_at: finishedAt,
      finished_at: null,
      outcome: { kind: 'blocked', error: outcome.summary },
    };
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
      const processor = new PlanningCardProcessorActor({ projectRoot: this.options.projectRoot, cardId: card.id, store: this.options.actorStore, children: this.childrenPort(), provider: this.options.provider, admission: this });
      processor.start();
      return processor;
    }
    if (card.type === 'goal') {
      const processor = new PlanningCardProcessorActor({ projectRoot: this.options.projectRoot, cardId: card.id, store: this.options.actorStore, children: this.childrenPort(), provider: this.options.provider, admission: this });
      processor.start();
      return processor;
    }
    const processor = new TerminalCardProcessorActor({ projectRoot: this.options.projectRoot, cardId: card.id, provider: this.options.provider, admission: this, store: this.options.actorStore });
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
