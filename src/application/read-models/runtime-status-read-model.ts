import type { ActiveRuntime } from '../../runtime/index.js';
import { readRuntimeState } from '../../runtime/index.js';
import type { ServerAvailability } from '../../contracts/index.js';

export interface RuntimeStatusReadModel {
  runtime: string;
  paused: boolean;
  currentCardId: string | null;
  goalCount: number;
  lastTickAt: string | null;
  pid: number;
  serverAvailability?: ServerAvailability;
}

export interface RuntimeStatusInputs {
  projectRoot: string;
  activeRuntime?: Pick<ActiveRuntime, 'getStatus'>;
  pid?: number;
  serverAvailability?: ServerAvailability;
}

export function buildRuntimeStatusReadModel(inputs: RuntimeStatusInputs): RuntimeStatusReadModel {
  const pid = inputs.pid ?? process.pid;
  if (inputs.activeRuntime) {
    const status = inputs.activeRuntime.getStatus();
    return {
      runtime: status.status,
      paused: status.paused,
      currentCardId: status.currentCardId,
      goalCount: status.goalCount,
      lastTickAt: status.lastTickAt,
      pid,
      ...(inputs.serverAvailability ? { serverAvailability: inputs.serverAvailability } : {}),
    };
  }
  const state = readRuntimeState(inputs.projectRoot);
  return {
    runtime: state?.status ?? 'unknown',
    paused: state?.paused ?? false,
    currentCardId: state?.current_card_id ?? null,
    goalCount: 0,
    lastTickAt: state?.last_tick_at ?? null,
    pid,
    ...(inputs.serverAvailability ? { serverAvailability: inputs.serverAvailability } : {}),
  };
}

export function buildRuntimeStateSnapshotContent(inputs: RuntimeStatusInputs): Record<string, unknown> {
  return { event: 'runtime-state', ...buildRuntimeStatusReadModel(inputs) };
}
