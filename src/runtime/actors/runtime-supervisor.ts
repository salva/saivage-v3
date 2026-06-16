import { SlaveActor, startActor } from '../micro-actor/index.js';
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
        calls: { start: 'setProjectRoot', stop: 'stop', pause: 'pause', request_provider_call: 'requestProviderCall', release_provider_call: 'releaseProviderCall' },
      },
      paused: {
        on: { resume: 'running', stop: 'stopping' },
        calls: { start: 'setProjectRoot', stop: 'stop', resume: 'resume', request_provider_call: 'requestProviderCall', release_provider_call: 'releaseProviderCall' },
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
  private readonly actor = startActor(RuntimeSupervisorActor);

  start(projectRoot: string): void {
    this.actor.mailbox.deliver('start', { projectRoot });
  }

  stop(): void {
    this.actor.mailbox.deliver('stop');
  }

  pause(): void {
    this.actor.mailbox.deliver('pause');
  }

  resume(): void {
    this.actor.mailbox.deliver('resume');
  }

  requestProviderCall(callId: string): boolean {
    if (this.work !== 'ready' || this.mode !== 'running') return false;
    this.actor.mailbox.deliver('request_provider_call', { callId });
    return true;
  }

  releaseProviderCall(callId: string): void {
    this.actor.mailbox.deliver('release_provider_call', { callId });
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
