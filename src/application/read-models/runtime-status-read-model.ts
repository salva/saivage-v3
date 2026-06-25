import type { RuntimeApi } from '../../runtime/control-api.js';
import type { ServerAvailability } from '../../contracts/index.js';
import type { ActorRuntimeReadModel } from './actor-runtime-read-model.js';
import type { RuntimeStatus } from '../../schemas/index.js';

export interface RuntimeStatusReadModel {
  runtime: RuntimeStatus;
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
  runtimeApi: Pick<RuntimeApi, 'getStatus' | 'getActorRuntimeReadModel'>;
  pid?: number;
  serverAvailability?: ServerAvailability;
}

export function buildRuntimeStatusReadModel(inputs: RuntimeStatusInputs): RuntimeStatusReadModel {
  const pid = inputs.pid ?? process.pid;
  const status = inputs.runtimeApi.getStatus();
  return {
    runtime: status.status,
    paused: status.paused,
    currentCardId: status.currentCardId,
    goalCount: status.goalCount,
    lastTickAt: status.lastTickAt,
    pid,
    actorRuntime: inputs.runtimeApi.getActorRuntimeReadModel(),
    ...(inputs.serverAvailability ? { serverAvailability: inputs.serverAvailability } : {}),
  };
}
