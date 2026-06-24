import { EventBus } from '../../events/index.js';
import { createActionableErrorEnvelope } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { buildActorRecoveryPlan, cleanupConvertedRecoverySnapshots, cleanupHandledRecoverySnapshots, convertActorRecoveryOutcomes, recoverProjectedTerminalToolOutcomes, writeRecoveryDiagnostics } from './actor-recovery.js';
import { abandonStalePendingToolCalls } from './llm-delivery-log.js';
import { plannerActorId } from './ids.js';
import { RuntimeSupervisorActor } from './runtime-supervisor.js';
import { CardActor, type CardActorStorePort } from './card-actor.js';
import { PlanningCardProcessorActor, type PlannerChildActorPort } from './planning-card-processor-actor.js';
import { TerminalCardProcessorActor } from './terminal-card-processor-actor.js';
import type { LLMProviderPort } from './llm-actor.js';
import type { RuntimeApi, RuntimeCommandSource, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import type { CardRecord, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState, RuntimeStatus } from '../../schemas/index.js';
import type { SessionActivity } from '../session-stamper.js';
import type { Subscription, SubscriptionOptions } from '../../events/index.js';
import type { ActorRecoveryPlan } from './actor-recovery.js';

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
  private recoveryPlan: ActorRecoveryPlan | null = null;
  private readonly cardActors = new Map<string, CardActor>();

  constructor(private readonly options: SupervisorRuntimeApiOptions) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.recoveryPlan = buildActorRecoveryPlan(this.options.projectRoot, this.options.actorStore);
    writeRecoveryDiagnostics(this.options.projectRoot, this.recoveryPlan, this.now());
    const terminalRecoveries = recoverProjectedTerminalToolOutcomes(this.recoveryPlan, {
      projectRoot: this.options.projectRoot,
      store: this.options.actorStore,
      generatedAt: this.now(),
      makePlanningProcessor: (cardId) => new PlanningCardProcessorActor({ projectRoot: this.options.projectRoot, cardId, store: this.options.actorStore, children: this.childrenPort(), provider: this.options.provider, admission: this }),
      makeTerminalProcessor: (cardId) => new TerminalCardProcessorActor({ projectRoot: this.options.projectRoot, cardId, provider: this.options.provider, admission: this }),
    });
    cleanupConvertedRecoverySnapshots(this.options.projectRoot, terminalRecoveries);
    const conversionPlan = terminalRecoveries.length > 0 ? buildActorRecoveryPlan(this.options.projectRoot, this.options.actorStore) : this.recoveryPlan;
    const conversions = convertActorRecoveryOutcomes(conversionPlan, this.options.actorStore, this.now());
    cleanupConvertedRecoverySnapshots(this.options.projectRoot, conversions);
    cleanupHandledRecoverySnapshots(this.options.projectRoot, conversionPlan);
    abandonStalePendingToolCalls(this.options.projectRoot);
    this.supervisor.start();
    this.supervisor.initialize(this.options.projectRoot);
    this.started = true;
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
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
    this.activeRun = {
      ...this.activeRun,
      phase: outcome.status === 'done' ? 'completed' : outcome.status,
      runtime_status: outcome.status === 'done' ? 'idle' : outcome.status === 'cancelled' ? 'cancelled' : 'running',
      updated_at: finishedAt,
      finished_at: outcome.status === 'blocked' ? null : finishedAt,
      outcome: outcome.status === 'done'
        ? { kind: 'completed', result: 'done', finished_at: finishedAt }
        : outcome.status === 'failed'
          ? { kind: 'completed', result: 'failed', error: outcome.summary, finished_at: finishedAt }
          : outcome.status === 'cancelled'
            ? { kind: 'completed', result: 'cancelled', finished_at: finishedAt }
            : { kind: 'blocked', error: outcome.summary },
    };
    if (outcome.status === 'done' || outcome.status === 'failed' || outcome.status === 'cancelled') {
      this.currentCardId = null;
      this.supervisor.cancelProject();
    }
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

  getActivityStatus(_sessionId: string): SessionActivity {
    return { status: 'idle', pending_calls: [], updated_at: this.now() };
  }

  getRecoveryPlan(): ActorRecoveryPlan | null {
    return this.recoveryPlan;
  }

  requestProviderCall(callId: string): boolean {
    return this.supervisor.requestProviderCall({ callId });
  }

  releaseProviderCall(callId: string): void {
    this.supervisor.releaseProviderCall({ callId });
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
    const processor = new TerminalCardProcessorActor({ projectRoot: this.options.projectRoot, cardId: card.id, provider: this.options.provider, admission: this });
    processor.start();
    return processor;
  }

  private childrenPort(): PlannerChildActorPort {
    return { get: (cardId) => this.cardActor(cardId) };
  }
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): RuntimeApi {
  return new SupervisorRuntimeApi(options);
}
