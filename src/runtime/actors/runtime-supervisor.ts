import { BaseActor } from '../micro-actor/index.js';
import { saveActorSnapshot } from './snapshots.js';
import { supervisorActorId } from './ids.js';

export type RuntimeSupervisorMode = 'idle' | 'running' | 'paused';
export type RuntimeSupervisorWork = 'ready';

export interface RuntimeSupervisorContext extends Record<string, unknown> {
  projectRoot: string | null;
}

export class RuntimeSupervisorActor extends BaseActor {
  static _actor = {
    initial: 'idle',
    states: {
      idle: { parked: true, on: { run: 'running' } },
      running: { parked: true, on: { pause: 'paused', cancel: 'idle', settle: 'idle' } },
      paused: { parked: true, on: { run: 'running', cancel: 'idle', settle: 'idle' } },
    },
  };

  projectRoot: string | null = null;

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
    return 'ready';
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
    if (this.mode === 'idle') return false;
    this.parkedSendEvent('cancel');
    return true;
  }

  cancelProject(): boolean {
    if (this.mode === 'idle') return false;
    this.parkedSendEvent('cancel');
    return true;
  }

  settleProject(): boolean {
    if (this.mode === 'idle') return false;
    this.parkedSendEvent('settle');
    return true;
  }

  protected override _on_state_changed(_oldState: string | undefined, _newState: string): void {
    this.persist();
  }

  snapshot(): { actor_id: string; actor_kind: 'supervisor'; state_value: { mode: RuntimeSupervisorMode; work: RuntimeSupervisorWork }; context: RuntimeSupervisorContext; updated_at: string } {
    return {
      actor_id: supervisorActorId(),
      actor_kind: 'supervisor' as const,
      state_value: { mode: this.mode, work: this.work },
      context: { projectRoot: this.projectRoot },
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    if (!this.projectRoot) return;
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}
