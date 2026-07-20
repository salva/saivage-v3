import type { RuntimeApi } from '../../runtime/control-api.js';
import type { RuntimeStatusResponse, ServerAvailability } from '../../contracts/index.js';

export type RuntimeStatusReadModel = Omit<RuntimeStatusResponse, 'restart_server_available'>;

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
