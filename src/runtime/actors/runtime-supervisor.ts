import { BaseActor, dispatchCall, dispatchEvent, startActor } from '../fsm/index.js';
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

export class RuntimeSupervisorActor extends BaseActor {
  static _actor = {
    initial: 'running',
    states: {
      running: {
        on: { pause: 'paused', stop: 'stopping' },
        calls: { start: 'setProjectRoot', request_provider_call: 'requestProviderCall', release_provider_call: 'releaseProviderCall' },
      },
      paused: {
        on: { resume: 'running', stop: 'stopping' },
        calls: { start: 'setProjectRoot', request_provider_call: 'requestProviderCall', release_provider_call: 'releaseProviderCall' },
      },
      stopping: {
        calls: { start: 'setProjectRoot', request_provider_call: 'requestProviderCall', release_provider_call: 'releaseProviderCall' },
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
  }

  requestProviderCall(args: ProviderCallArgs): void {
    this.activeProviderCallId = args.callId;
  }

  releaseProviderCall(args: ProviderCallArgs): void {
    if (this.activeProviderCallId === args.callId) {
      this.activeProviderCallId = null;
    }
  }
}

export class RuntimeSupervisorController {
  private readonly actor = startActor(RuntimeSupervisorActor);

  start(projectRoot: string): void {
    dispatchCall(this.actor, { kind: 'call', name: 'start', args: { projectRoot } });
    this.persist();
  }

  stop(): void {
    dispatchEvent(this.actor, { kind: 'event', name: 'stop' });
    this.persist();
  }

  pause(): void {
    dispatchEvent(this.actor, { kind: 'event', name: 'pause' });
    this.persist();
  }

  resume(): void {
    dispatchEvent(this.actor, { kind: 'event', name: 'resume' });
    this.persist();
  }

  requestProviderCall(callId: string): boolean {
    if (this.work !== 'ready' || this.mode !== 'running') return false;
    dispatchCall(this.actor, { kind: 'call', name: 'request_provider_call', args: { callId } });
    this.persist();
    return true;
  }

  releaseProviderCall(callId: string): void {
    dispatchCall(this.actor, { kind: 'call', name: 'release_provider_call', args: { callId } });
    this.persist();
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

  private persist(): void {
    const projectRoot = this.context.projectRoot;
    if (!projectRoot) return;
    saveActorSnapshot(projectRoot, this.snapshot());
  }
}
