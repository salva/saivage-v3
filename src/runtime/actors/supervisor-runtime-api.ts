import { EventBus } from '../../events/index.js';
import { createActionableErrorEnvelope } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { buildActorRecoveryPlan } from './actor-recovery.js';
import { abandonStalePendingToolCalls } from './llm-delivery-log.js';
import { plannerActorId } from './ids.js';
import { RuntimeSupervisorActor } from './runtime-supervisor.js';
import type { RuntimeApi, RuntimeCommandSource, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import type { RuntimeCommandRecord, RuntimeRunRecord, RuntimeState, RuntimeStatus } from '../../schemas/index.js';
import type { SessionActivity } from '../session-stamper.js';
import type { Subscription, SubscriptionOptions } from '../../events/index.js';
import type { RuntimeContextCardReader } from '../context-builder.js';
import type { ActorRecoveryPlan } from './actor-recovery.js';

export interface ProjectRootCardReader {
  read(cardId: string): { id: string; type: string } | null;
}

export interface SupervisorRuntimeApiOptions {
  projectRoot: string;
  eventBus?: EventBus;
  now?: () => string;
  rootCards?: ProjectRootCardReader;
  contextCards?: RuntimeContextCardReader;
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

  constructor(private readonly options: SupervisorRuntimeApiOptions) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.recoveryPlan = buildActorRecoveryPlan(this.options.projectRoot, this.options.rootCards);
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
    const rootCard = this.options.rootCards?.read(PROJECT_CARD_ID) ?? null;
    if (this.options.rootCards && !rootCard) {
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
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): RuntimeApi {
  return new SupervisorRuntimeApi(options);
}
