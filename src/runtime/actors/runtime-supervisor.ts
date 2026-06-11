import { assign, createActor, createMachine } from 'xstate';
import { saveActorSnapshot } from './snapshots.js';
import { supervisorActorId } from './ids.js';

export type RuntimeSupervisorMode = 'running' | 'paused' | 'stopping';
export type RuntimeSupervisorWork = 'ready' | 'model_invocation_active';

export interface RuntimeSupervisorContext {
  projectRoot: string | null;
  activeProviderCallId: string | null;
}

type RuntimeSupervisorEvent =
  | { type: 'START'; projectRoot: string }
  | { type: 'STOP' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'REQUEST_PROVIDER_CALL'; callId: string }
  | { type: 'RELEASE_PROVIDER_CALL'; callId: string };

export const runtimeSupervisorMachine = createMachine({
  types: {} as {
    context: RuntimeSupervisorContext;
    events: RuntimeSupervisorEvent;
  },
  id: 'runtimeSupervisor',
  type: 'parallel',
  context: { projectRoot: null, activeProviderCallId: null },
  states: {
    mode: {
      initial: 'running',
      states: {
        running: { on: { PAUSE: 'paused', STOP: 'stopping' } },
        paused: { on: { RESUME: 'running', STOP: 'stopping' } },
        stopping: {},
      },
    },
    work: {
      initial: 'ready',
      states: {
        ready: {
          on: {
            REQUEST_PROVIDER_CALL: {
              target: 'model_invocation_active',
              actions: assign({ activeProviderCallId: ({ event }) => event.callId }),
            },
          },
        },
        model_invocation_active: {
          on: {
            RELEASE_PROVIDER_CALL: {
              guard: ({ context, event }) => context.activeProviderCallId === event.callId,
              target: 'ready',
              actions: assign({ activeProviderCallId: null }),
            },
          },
        },
      },
    },
  },
  on: {
    START: { actions: assign({ projectRoot: ({ event }) => event.projectRoot }) },
  },
});

export class RuntimeSupervisorController {
  private readonly actor = createActor(runtimeSupervisorMachine);

  start(projectRoot: string): void {
    this.actor.start();
    this.actor.send({ type: 'START', projectRoot });
    this.persist();
  }

  stop(): void {
    this.actor.send({ type: 'STOP' });
    this.persist();
  }

  pause(): void {
    this.actor.send({ type: 'PAUSE' });
    this.persist();
  }

  resume(): void {
    this.actor.send({ type: 'RESUME' });
    this.persist();
  }

  requestProviderCall(callId: string): boolean {
    if (this.work !== 'ready' || this.mode !== 'running') return false;
    this.actor.send({ type: 'REQUEST_PROVIDER_CALL', callId });
    this.persist();
    return true;
  }

  releaseProviderCall(callId: string): void {
    this.actor.send({ type: 'RELEASE_PROVIDER_CALL', callId });
    this.persist();
  }

  get mode(): RuntimeSupervisorMode {
    const value = this.actor.getSnapshot().value;
    if (typeof value !== 'object' || value === null || !('mode' in value)) throw new Error('RuntimeSupervisor snapshot missing mode region.');
    return value.mode as RuntimeSupervisorMode;
  }

  get work(): RuntimeSupervisorWork {
    const value = this.actor.getSnapshot().value;
    if (typeof value !== 'object' || value === null || !('work' in value)) throw new Error('RuntimeSupervisor snapshot missing work region.');
    return value.work as RuntimeSupervisorWork;
  }

  get context(): RuntimeSupervisorContext {
    return this.actor.getSnapshot().context;
  }

  snapshot() {
    const snapshot = this.actor.getSnapshot();
    return {
      actor_id: supervisorActorId(),
      actor_kind: 'supervisor' as const,
      state_value: snapshot.value,
      context: snapshot.context as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    const projectRoot = this.context.projectRoot;
    if (!projectRoot) return;
    saveActorSnapshot(projectRoot, this.snapshot());
  }
}
