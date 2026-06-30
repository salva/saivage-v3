import { z } from 'zod';

export const actorKinds = ['supervisor', 'card', 'llm', 'process', 'processor'] as const;
export type ActorKind = typeof actorKinds[number];
export const actorKindSchema = z.enum(actorKinds);

export const llmActorRoles = ['planner', 'reviewer', 'executor', 'analyst'] as const;
export type LlmActorRole = typeof llmActorRoles[number];
export const llmActorRoleSchema = z.enum(llmActorRoles);

export const cardActorStates = ['backlog', 'changed', 'blocked', 'failed', 'done', 'running', 'cancelled', 'needs_verification'] as const;
export type CardActorState = typeof cardActorStates[number];
export const cardActorStateSchema = z.enum(cardActorStates);

export const llmActorPhases = ['idle', 'calling_provider', 'waiting_tool'] as const;
export type LlmActorPhase = typeof llmActorPhases[number];
export const llmActorPhaseSchema = z.enum(llmActorPhases);

export const publicCardActorStates = ['backlog', 'changed', 'blocked', 'failed', 'done', 'running', 'cancelled', 'needs_verification'] as const;
export type PublicCardActorState = typeof publicCardActorStates[number];
export const publicCardActorStateSchema = z.enum(publicCardActorStates);

export const publicAgentPhases = ['idle', 'calling_provider', 'waiting_for_tool'] as const;
export type PublicAgentPhase = typeof publicAgentPhases[number];
export const publicAgentPhaseSchema = z.enum(publicAgentPhases);

export const actorPauseModes = ['idle', 'running', 'paused', 'stopping', 'unknown'] as const;
export type ActorPauseMode = typeof actorPauseModes[number];
export const actorPauseModeSchema = z.enum(actorPauseModes);

export const supervisorModes = ['idle', 'running', 'paused', 'shutting_down'] as const;
export type SupervisorMode = typeof supervisorModes[number];
export const supervisorModeSchema = z.enum(supervisorModes);

export const supervisorWorkStates = ['ready', 'model_invocation_active', 'shutdown_active'] as const;
export type SupervisorWorkState = typeof supervisorWorkStates[number];
export const supervisorWorkStateSchema = z.enum(supervisorWorkStates);

export function parseCardActorState(value: unknown): CardActorState | null {
  const result = cardActorStateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseLlmActorPhase(value: unknown): LlmActorPhase | null {
  const result = llmActorPhaseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function toPublicCardActorState(value: unknown): PublicCardActorState {
  const result = publicCardActorStateSchema.safeParse(value);
  if (!result.success) throw new Error(`Unknown card actor state '${String(value)}'.`);
  return result.data;
}

export function toPublicAgentPhase(value: unknown): PublicAgentPhase {
  const phase = parseLlmActorPhase(value);
  if (phase === 'waiting_tool') return 'waiting_for_tool';
  if (phase === 'idle' || phase === 'calling_provider') return phase;
  throw new Error(`Unknown LLM actor phase '${String(value)}'.`);
}

export function readSupervisorModeValue(value: unknown): SupervisorMode | null {
  if (!value || typeof value !== 'object' || !('mode' in value)) return null;
  const result = supervisorModeSchema.safeParse((value as { mode: unknown }).mode);
  return result.success ? result.data : null;
}

export function readSupervisorWorkValue(value: unknown): SupervisorWorkState | null {
  if (!value || typeof value !== 'object' || !('work' in value)) return null;
  const result = supervisorWorkStateSchema.safeParse((value as { work: unknown }).work);
  return result.success ? result.data : null;
}
