import { EventBus } from '../../events/index.js';
import { createActionableErrorEnvelope } from '../../schemas/index.js';
import { RuntimeSupervisorController } from './runtime-supervisor.js';
import type { RuntimeApi, RuntimeCommandSource, StartProjectResult, StopProjectResult } from '../runtime-api.js';
import type { RuntimeCommandRecord, RuntimeState, RuntimeStatus } from '../../schemas/index.js';
import type { SessionActivity } from '../session-stamper.js';
import type { Subscription, SubscriptionOptions } from '../../events/index.js';

export interface SupervisorRuntimeApiOptions {
  projectRoot: string;
  eventBus?: EventBus;
  now?: () => string;
}

export class SupervisorRuntimeApi implements RuntimeApi {
  private readonly supervisor = new RuntimeSupervisorController();
  private readonly eventBus: EventBus;
  private readonly now: () => string;
  private started = false;
  private commandCounter = 0;

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
      currentCardId: null,
      goalCount: 0,
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
}

export function createSupervisorRuntimeApi(options: SupervisorRuntimeApiOptions): RuntimeApi {
  return new SupervisorRuntimeApi(options);
}
