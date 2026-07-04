import type { RuntimeApi } from '../../runtime/control-api.js';
import type { ServerAvailability } from '../../contracts/index.js';
import type { ActorRuntimeReadModel } from './actor-runtime-read-model.js';
import type { RuntimeCommandRecord, RuntimeRunRecord, RuntimeStatus } from '../../schemas/index.js';
import { readRuntimeState } from '../../runtime/state-api.js';

export interface RuntimeStatusReadModel {
  runtime: RuntimeStatus;
  currentCardId: string | null;
  goalCount: number;
  lastTickAt: string | null;
  pid: number;
  actorRuntime: ActorRuntimeReadModel;
  lastCommand: RuntimeCommandRecord | null;
  activeRun: RuntimeRunRecord | null;
  latestRun: RuntimeRunRecord | null;
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
  const persisted = readRuntimeState(inputs.projectRoot);
  const latestRun = persisted?.runtime_runs.at(-1) ?? null;
  const activeRun = persisted?.runtime_runs.find((run) => run.runtime_status === 'running') ?? null;
  return {
    runtime: status.status,
    currentCardId: status.currentCardId,
    goalCount: status.goalCount,
    lastTickAt: status.lastTickAt,
    pid,
    actorRuntime: inputs.runtimeApi.getActorRuntimeReadModel(),
    lastCommand: persisted?.runtime_commands.at(-1) ?? null,
    activeRun,
    latestRun,
    ...(inputs.serverAvailability ? { serverAvailability: inputs.serverAvailability } : {}),
  };
}
