import { z } from 'zod';

export const actorKinds = ['card', 'llm', 'processor'] as const;
export type ActorKind = typeof actorKinds[number];
export const actorKindSchema = z.enum(actorKinds);

export const llmActorRoles = ['planner', 'reviewer', 'executor', 'analyst'] as const;
export type LlmActorRole = typeof llmActorRoles[number];
export const llmActorRoleSchema = z.enum(llmActorRoles);

export const llmActorPhases = ['idle', 'calling_provider', 'waiting_tool'] as const;
export type LlmActorPhase = typeof llmActorPhases[number];
export const llmActorPhaseSchema = z.enum(llmActorPhases);

export const publicCardActorStates = ['backlog', 'changed', 'blocked', 'stopped', 'failed', 'done', 'running', 'cancelled'] as const;
export type PublicCardActorState = typeof publicCardActorStates[number];
export const publicCardActorStateSchema = z.enum(publicCardActorStates);

export const actorPauseModes = ['idle', 'running', 'paused', 'unknown'] as const;
export type ActorPauseMode = typeof actorPauseModes[number];
export const actorPauseModeSchema = z.enum(actorPauseModes);

export function parseLlmActorPhase(value: unknown): LlmActorPhase | null {
  const result = llmActorPhaseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function toPublicCardActorState(value: unknown): PublicCardActorState {
  const result = publicCardActorStateSchema.safeParse(value);
  if (!result.success) throw new Error(`Unknown card actor state '${String(value)}'.`);
  return result.data;
}
