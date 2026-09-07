import type { RuntimeApi } from '../../runtime/runtime-api.js';
import type { RuntimeStatusResponse, ServerAvailability } from '../../contracts/index.js';
import type { RestartCapability } from '../../contracts/index.js';

type RuntimeStatusReadModel = RuntimeStatusResponse;

export interface RuntimeStatusInputs {
  runtimeApi: Pick<RuntimeApi, 'getStatus' | 'getActorRuntimeReadModel'>;
  serverAvailability: ServerAvailability;
  restartCapability: RestartCapability;
}

export function buildRuntimeStatusReadModel(inputs: RuntimeStatusInputs): RuntimeStatusReadModel {
  const status = inputs.runtimeApi.getStatus();
  return {
    runtime: status.status,
    currentCardId: status.currentCardId,
    started_at: status.startedAt,
    pid: status.pid,
    actorRuntime: inputs.runtimeApi.getActorRuntimeReadModel(),
    restart_server_available: inputs.restartCapability.available,
    serverAvailability: inputs.serverAvailability,
  };
}
