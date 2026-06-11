import { EventBus } from '../../events/index.js';
import { createActionableErrorEnvelope } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/project-card.js';
import { buildXStatePlannerInput } from './actor-input-builders.js';
import { GoalCardRunnerController } from './goal-card-runner.js';
import { plannerActorId } from './ids.js';
import { RuntimeSupervisorController } from './runtime-supervisor.js';
import { createXStateChildActivation } from './xstate-child-activation.js';
import type { RuntimeApi, RuntimeCommandSource, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import type { RuntimeCommandRecord, RuntimeRunRecord, RuntimeState, RuntimeStatus } from '../../schemas/index.js';
import type { SessionActivity } from '../session-stamper.js';
import type { Subscription, SubscriptionOptions } from '../../events/index.js';
import type { ChildActivationPort } from './goal-card-runner.js';
import type { GoalCardStatusPort } from './goal-card-runner.js';
import type { ProviderTurnPort } from './llm-runner.js';
import type { TerminalCardStatusPort } from './card-runner.js';
import type { XStateChildCardReader } from './xstate-child-activation.js';
import type { RuntimeContextCardReader } from '../context-builder.js';

export type ProjectRootCardReader = XStateChildCardReader;

export interface SupervisorRuntimeApiOptions {
  projectRoot: string;
  eventBus?: EventBus;
  now?: () => string;
  rootCards?: ProjectRootCardReader;
  contextCards?: RuntimeContextCardReader;
  providerTurn?: ProviderTurnPort;
  reviewerProviderTurn?: ProviderTurnPort;
  childActivation?: ChildActivationPort;
  goalStatusPort?: GoalCardStatusPort;
  terminalStatusPort?: TerminalCardStatusPort;
}

export class SupervisorRuntimeApi implements RuntimeApi {
  private readonly supervisor = new RuntimeSupervisorController();
  private readonly eventBus: EventBus;
  private readonly now: () => string;
  private started = false;
  private commandCounter = 0;
  private runCounter = 0;
  private currentCardId: string | null = null;

  constructor(private readonly options: SupervisorRuntimeApiOptions) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.supervisor.start(this.options.projectRoot);
    this.started = true;
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.supervisor.stop();
    this.started = false;
  }

  pause(): void {
    this.supervisor.pause();
  }

  resume(): void {
    this.supervisor.resume();
  }

  async startProject(source: RuntimeCommandSource = 'operator'): Promise<StartProjectResult> {
    await this.start();
    if (!this.options.providerTurn) {
      const command = this.command('start_project', 'rejected', source);
      const error = createActionableErrorEnvelope({
        code: 'xstate_runtime_not_wired',
        message: 'The XState runtime shell is available but project execution is not wired yet.',
        currentState: { mode: this.supervisor.mode, work: this.supervisor.work },
        nextAction: 'Provide a ProviderTurnPort before starting project execution through the XState runtime shell.',
        docsRef: 'docs/design/card-runner-xstate-porting-plan.md',
      });
      return { success: false, command: { ...command, error }, error };
    }
    const rootCard = this.options.rootCards?.read(PROJECT_CARD_ID) ?? null;
    if (!rootCard) {
      const command = this.command('start_project', 'rejected', source);
      const error = createActionableErrorEnvelope({
        code: 'xstate_project_card_missing',
        message: `Cannot start XState runtime: project card '${PROJECT_CARD_ID}' was not found.`,
        cardId: PROJECT_CARD_ID,
        currentState: { mode: this.supervisor.mode, work: this.supervisor.work },
        nextAction: `Create or repair the canonical project card '${PROJECT_CARD_ID}' before starting runtime execution.`,
        docsRef: 'docs/design/card-runner-xstate-porting-plan.md',
      });
      return { success: false, command: { ...command, error }, error };
    }
    const command = this.command('start_project', 'completed', source);
    const startedAt = this.now();
    this.currentCardId = PROJECT_CARD_ID;
    const childActivation = this.options.childActivation ?? (this.options.rootCards
      ? createXStateChildActivation({
        projectRoot: this.options.projectRoot,
        cards: this.options.rootCards,
        contextCards: this.options.contextCards,
        providerTurn: this.options.providerTurn,
        admission: this.supervisor,
        reviewerProviderTurn: this.options.reviewerProviderTurn,
        goalStatusPort: this.options.goalStatusPort,
        terminalStatusPort: this.options.terminalStatusPort,
      })
      : missingChildActivation());
    const runner = new GoalCardRunnerController(
      this.options.projectRoot,
      PROJECT_CARD_ID,
      this.options.providerTurn,
      childActivation,
      {
        admission: this.supervisor,
        reviewerProviderTurn: this.options.reviewerProviderTurn,
        statusPort: this.options.goalStatusPort,
        card: { id: PROJECT_CARD_ID, type: 'project' },
        context: { cards: this.options.contextCards },
      },
    );
    const outcome = await runner.start(buildXStatePlannerInput({
      inputId: `start-project:${command.command_id}`,
      card: { id: PROJECT_CARD_ID, type: 'project' },
      sourceCommandId: command.command_id,
      context: { cards: this.options.contextCards },
    }));
    const finishedAt = this.now();
    this.currentCardId = null;
    return {
      success: true,
      command,
      intent: { status: 'stopped', updated_at: finishedAt, source_command_id: command.command_id, reason: `xstate_project_${outcome.status}` },
      run: this.runRecord(command.command_id, startedAt, finishedAt, outcome.status, outcome.statusText),
    };
  }

  private unwiredProjectStart(source: RuntimeCommandSource): StartProjectResult {
    const command = this.command('start_project', 'rejected', source);
    const error = createActionableErrorEnvelope({
      code: 'xstate_runtime_not_wired',
      message: 'The XState runtime shell is available but project execution is not wired yet.',
      currentState: { mode: this.supervisor.mode, work: this.supervisor.work },
      nextAction: 'Use the existing runtime until the XState goal execution switchover is complete.',
      docsRef: 'docs/design/card-runner-xstate-porting-plan.md',
    });
    return { success: false, command: { ...command, error }, error };
  }

  async stopProject(source: RuntimeCommandSource = 'operator'): Promise<StopProjectResult> {
    return {
      success: true,
      command: this.command('stop_project', 'completed', source),
      intent: { status: 'stopped', updated_at: this.now(), source_command_id: null, reason: 'xstate_runtime_shell_stop' },
    };
  }

  subscribe(options: SubscriptionOptions): Subscription {
    return this.eventBus.subscribe(options);
  }

  getStatus(): { status: RuntimeStatus; paused: boolean; currentCardId: string | null; goalCount: number; lastTickAt: string | null } {
    const mode = this.started ? this.supervisor.mode : 'stopping';
    return {
      status: mode === 'paused' ? 'paused' : this.started ? 'idle' : 'idle',
      paused: mode === 'paused',
      currentCardId: this.currentCardId,
      goalCount: this.currentCardId ? 1 : 0,
      lastTickAt: null,
    };
  }

  getActivityStatus(_sessionId: string): SessionActivity {
    return { status: 'idle', pending_calls: [], updated_at: this.now() };
  }

  private command(command: RuntimeCommandRecord['command'], status: RuntimeCommandRecord['status'], source: RuntimeCommandSource): RuntimeCommandRecord {
    this.commandCounter++;
    const at = this.now();
    return {
      command_id: `xstate-command-${this.commandCounter}`,
      command,
      status,
      requested_at: at,
      completed_at: at,
      source,
      error: null,
    };
  }

  private runRecord(commandId: string, startedAt: string, finishedAt: string, status: string, statusText: string): RuntimeRunRecord {
    this.runCounter++;
    const failed = status !== 'done';
    return {
      run_id: `xstate-run-${this.runCounter}`,
      kind: 'root',
      card_id: PROJECT_CARD_ID,
      ownership: { kind: 'direct', source: 'project_root' },
      parent_run_id: null,
      command_id: commandId,
      activation_id: null,
      phase: failed ? 'failed' : 'completed',
      runtime_status: 'idle',
      session_id: plannerActorId(PROJECT_CARD_ID),
      started_at: startedAt,
      updated_at: finishedAt,
      finished_at: finishedAt,
      outcome: failed
        ? { kind: 'completed', result: 'failed', error: statusText, finished_at: finishedAt }
        : { kind: 'completed', result: 'done', finished_at: finishedAt },
    };
  }
}

function missingChildActivation(): ChildActivationPort {
  return {
    async startChild(cardId: string) {
      return { status: 'blocked', statusText: `No XState child activation port is configured for '${cardId}'.` };
    },
  };
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): RuntimeApi {
  return new SupervisorRuntimeApi(options);
}
