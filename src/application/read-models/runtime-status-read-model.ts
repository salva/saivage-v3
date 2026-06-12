import type { RuntimeApi } from '../../runtime/control-api.js';
import { readRuntimeState } from '../../runtime/state-api.js';
import { deriveCurrentCardId } from '../../runtime/current-run.js';
import { buildActorRuntimeReadModel } from './actor-runtime-read-model.js';
import type { ServerAvailability } from '../../contracts/index.js';
import type { ActorRuntimeReadModel } from './actor-runtime-read-model.js';

export interface RuntimeStatusReadModel {
  runtime: string;
  paused: boolean;
  currentCardId: string | null;
  goalCount: number;
  lastTickAt: string | null;
  pid: number;
  actorRuntime: ActorRuntimeReadModel;
  serverAvailability?: ServerAvailability;
}

export interface RuntimeStatusInputs {
  projectRoot: string;
  runtimeApi?: Pick<RuntimeApi, 'getStatus'>;
  pid?: number;
  serverAvailability?: ServerAvailability;
}

export function buildRuntimeStatusReadModel(inputs: RuntimeStatusInputs): RuntimeStatusReadModel {
  const pid = inputs.pid ?? process.pid;
  if (inputs.runtimeApi) {
    const status = inputs.runtimeApi.getStatus();
    return {
      runtime: status.status,
      paused: status.paused,
      currentCardId: status.currentCardId,
      goalCount: status.goalCount,
      lastTickAt: status.lastTickAt,
      pid,
      actorRuntime: buildActorRuntimeReadModel(inputs.projectRoot),
      ...(inputs.serverAvailability ? { serverAvailability: inputs.serverAvailability } : {}),
    };
  }
  const state = readRuntimeState(inputs.projectRoot);
  return {
    runtime: state?.status ?? 'unknown',
    paused: state?.paused ?? false,
    currentCardId: deriveCurrentCardId(state),
    goalCount: 0,
    lastTickAt: state?.last_tick_at ?? null,
    pid,
    actorRuntime: buildActorRuntimeReadModel(inputs.projectRoot),
    ...(inputs.serverAvailability ? { serverAvailability: inputs.serverAvailability } : {}),
  };
}
