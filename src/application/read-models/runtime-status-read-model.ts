import type { RuntimeApi } from '../../runtime/control-api.js';
import type { ServerAvailability } from '../../contracts/index.js';
import type { ActorRuntimeReadModel } from './actor-runtime-read-model.js';
import type { RuntimeStatus } from '../../schemas/index.js';

export interface RuntimeStatusReadModel {
  runtime: RuntimeStatus;
  currentCardId: string | null;
  started_at: string;
  pid: number;
  actorRuntime: ActorRuntimeReadModel;
  serverAvailability?: ServerAvailability;
}

export interface RuntimeStatusInputs {
  runtimeApi: Pick<RuntimeApi, 'getStatus' | 'getActorRuntimeReadModel'>;
  serverAvailability?: ServerAvailability;
}

export function buildRuntimeStatusReadModel(inputs: RuntimeStatusInputs): RuntimeStatusReadModel {
  const status = inputs.runtimeApi.getStatus();
  return {
    runtime: status.status,
    currentCardId: status.currentCardId,
    started_at: status.startedAt,
    pid: status.pid,
    actorRuntime: inputs.runtimeApi.getActorRuntimeReadModel(),
    ...(inputs.serverAvailability ? { serverAvailability: inputs.serverAvailability } : {}),
  };
}
