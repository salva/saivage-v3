import { BaseActor } from '../micro-actor/index.js';
import { saveActorSnapshot } from './snapshots.js';
import { supervisorActorId } from './ids.js';

export type RuntimeSupervisorMode = 'idle' | 'running' | 'paused' | 'shutting_down';
export type RuntimeSupervisorWork = 'ready' | 'model_invocation_active' | 'shutdown_active';

export interface RuntimeSupervisorContext {
  projectRoot: string | null;
  activeProviderCallId: string | null;
}

type ProviderCallArgs = { callId: string };

export class RuntimeSupervisorActor extends BaseActor {
  static _actor = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { run: 'running', shutdown: 'shutting_down' } },
      running: { parked: true, on: { pause: 'paused', cancel: 'idle', shutdown: 'shutting_down' } },
      paused: { parked: true, on: { run: 'running', shutdown: 'shutting_down', cancel: 'idle' } },
      shutting_down: { on: { done: 'idle', failed: 'idle' } },
    },
  };

  projectRoot: string | null = null;
  activeProviderCallId: string | null = null;

  initialize(projectRoot: string): void {
    if (this.projectRoot !== null && this.projectRoot !== projectRoot) {
      throw new Error(`RuntimeSupervisorActor already initialized for '${this.projectRoot}'`);
    }
    this.projectRoot = projectRoot;
    this.persist();
  }

  get mode(): RuntimeSupervisorMode {
    return this.state() as RuntimeSupervisorMode;
  }

  get work(): RuntimeSupervisorWork {
    if (this.mode === 'shutting_down') return 'shutdown_active';
    return this.activeProviderCallId === null ? 'ready' : 'model_invocation_active';
  }

  run(): boolean {
    if (this.mode === 'running') return false;
    if (this.mode !== 'idle' && this.mode !== 'paused') return false;
    this.parkedSendEvent('run');
    return true;
  }

  pause(): boolean {
    if (this.mode !== 'running') return false;
    this.parkedSendEvent('pause');
    return true;
  }

  shutdown(): boolean {
    if (this.mode === 'shutting_down') return false;
    if (this.mode === 'idle' || this.mode === 'running' || this.mode === 'paused') {
      this.parkedSendEvent('shutdown');
      return true;
    }
    return false;
  }

  cancelProject(): boolean {
    if (this.mode === 'idle' || this.mode === 'shutting_down') return false;
    this.parkedSendEvent('cancel');
    return true;
  }

  requestProviderCall(args: ProviderCallArgs | string): boolean {
    const callId = typeof args === 'string' ? args : args.callId;
    if (this.mode !== 'running' || this.activeProviderCallId !== null) return false;
    this.activeProviderCallId = callId;
    this.persist();
    return true;
  }

  releaseProviderCall(args: ProviderCallArgs | string): void {
    const callId = typeof args === 'string' ? args : args.callId;
    if (this.activeProviderCallId === callId) {
      this.activeProviderCallId = null;
      this.persist();
    }
  }

  _on_enter__shutting_down(): void {
    this.runTask(async () => undefined);
  }

  protected override _on_state_changed(_oldState: string | undefined, newState: string): void {
    if (newState === 'idle') this.activeProviderCallId = null;
    this.persist();
  }

  snapshot() {
    return {
      actor_id: supervisorActorId(),
      actor_kind: 'supervisor' as const,
      state_value: { mode: this.mode, work: this.work },
      context: { projectRoot: this.projectRoot, activeProviderCallId: this.activeProviderCallId } as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    if (!this.projectRoot) return;
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}
