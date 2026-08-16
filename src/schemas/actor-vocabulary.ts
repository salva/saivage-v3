import { z } from 'zod';

export type LlmActorPhase = 'idle' | 'calling_provider' | 'waiting_tool';

export const publicCardActorStates = ['backlog', 'changed', 'blocked', 'stopped', 'failed', 'done', 'running', 'cancelled'] as const;
export type PublicCardActorState = typeof publicCardActorStates[number];
export const publicCardActorStateSchema = z.enum(publicCardActorStates);

export const actorPauseModes = ['idle', 'running', 'paused', 'unknown'] as const;
export type ActorPauseMode = typeof actorPauseModes[number];
export const actorPauseModeSchema = z.enum(actorPauseModes);

export function toPublicCardActorState(value: unknown): PublicCardActorState {
  const result = publicCardActorStateSchema.safeParse(value);
  if (!result.success) throw new Error(`Unknown card actor state '${String(value)}'.`);
  return result.data;
}
