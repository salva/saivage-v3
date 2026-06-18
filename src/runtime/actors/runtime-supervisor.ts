import { SlaveActor } from '../micro-actor/index.js';
import { saveActorSnapshot } from './snapshots.js';
import { supervisorActorId } from './ids.js';

export type RuntimeSupervisorMode = 'running' | 'paused' | 'stopping';
export type RuntimeSupervisorWork = 'ready' | 'model_invocation_active';

export interface RuntimeSupervisorContext {
  projectRoot: string | null;
  activeProviderCallId: string | null;
}

type StartArgs = { projectRoot: string };
type ProviderCallArgs = { callId: string };

export class RuntimeSupervisorActor extends SlaveActor {
  static _actor = {
    initial: 'running',
    states: {
      running: {
        on: { pause: 'paused', stop: 'stopping' },
      },
      paused: {
        on: { resume: 'running', stop: 'stopping' },
      },
      stopping: {
      },
    },
  };

  projectRoot: string | null = null;
  activeProviderCallId: string | null = null;

  get work(): RuntimeSupervisorWork {
    return this.activeProviderCallId === null ? 'ready' : 'model_invocation_active';
  }

  setProjectRoot(args: StartArgs): void {
    this.projectRoot = args.projectRoot;
    this.persist();
  }

  stop(): void {
    this._send_event('stop');
  }

  pause(): void {
    this._send_event('pause');
  }

  resume(): void {
    this._send_event('resume');
  }

  requestProviderCall(args: ProviderCallArgs): void {
    this.activeProviderCallId = args.callId;
    this.persist();
  }

  releaseProviderCall(args: ProviderCallArgs): void {
    if (this.activeProviderCallId === args.callId) {
      this.activeProviderCallId = null;
    }
    this.persist();
  }

  _on_enter__paused(): void {
    this.persist();
  }

  _on_enter__running(): void {
    this.persist();
  }

  _on_enter__stopping(): void {
    this.persist();
  }

  snapshot() {
    return {
      actor_id: supervisorActorId(),
      actor_kind: 'supervisor' as const,
      state_value: { mode: this.state() as RuntimeSupervisorMode, work: this.work },
      context: { projectRoot: this.projectRoot, activeProviderCallId: this.activeProviderCallId } as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    if (!this.projectRoot) return;
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }
}

export class RuntimeSupervisorController {
  private actor: RuntimeSupervisorActor;

  constructor() {
    const actor = new RuntimeSupervisorActor();
    actor.start();
    this.actor = actor;
  }

  start(projectRoot: string): void {
    this.actor.setProjectRoot({ projectRoot });
  }

  stop(): void {
    this.actor.stop();
  }

  pause(): void {
    this.actor.pause();
  }

  resume(): void {
    this.actor.resume();
  }

  requestProviderCall(callId: string): boolean {
    if (this.work !== 'ready' || this.mode !== 'running') return false;
    this.actor.requestProviderCall({ callId });
    return true;
  }

  releaseProviderCall(callId: string): void {
    this.actor.releaseProviderCall({ callId });
  }

  get mode(): RuntimeSupervisorMode {
    return this.actor.state() as RuntimeSupervisorMode;
  }

  get work(): RuntimeSupervisorWork {
    return this.actor.work;
  }

  get context(): RuntimeSupervisorContext {
    return {
      projectRoot: this.actor.projectRoot,
      activeProviderCallId: this.actor.activeProviderCallId,
    };
  }

  snapshot() {
    return {
      actor_id: supervisorActorId(),
      actor_kind: 'supervisor' as const,
      state_value: { mode: this.mode, work: this.work },
      context: this.context as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }
}
