import { llmActorRoles } from './actor-vocabulary.js';
import type { ActorKind, LlmActorRole } from './actor-vocabulary.js';

export { actorKindSchema, actorKinds, llmActorRoleSchema, llmActorRoles } from './actor-vocabulary.js';
export type { ActorKind, LlmActorRole } from './actor-vocabulary.js';

export function supervisorActorId(): string {
  return 'supervisor';
}

export function cardActorId(cardId: string): string {
  return `card:${cardId}`;
}

export function plannerActorId(cardId: string): string {
  return `planner:${cardId}`;
}

export function reviewerActorId(cardId: string): string {
  return `reviewer:${cardId}`;
}

export function executorActorId(cardId: string): string {
  return `executor:${cardId}`;
}

export function processorActorId(cardId: string): string {
  return `processor:${cardId}`;
}

export function actorKindFromId(actorId: string): ActorKind {
  if (actorId === supervisorActorId()) return 'supervisor';
  if (actorId.startsWith('card:')) return 'card';
  if (actorId.startsWith('planner:') || actorId.startsWith('reviewer:') || actorId.startsWith('executor:') || actorId.startsWith('analyst:')) return 'llm';
  if (actorId.startsWith('processor:')) return 'processor';
  throw new Error(`Unknown actor id: ${actorId}`);
}

export function parseCardActorId(actorId: string): string {
  if (!actorId.startsWith('card:')) throw new Error(`Expected card actor id, received '${actorId}'.`);
  return actorId.slice('card:'.length);
}

export function parseLlmActorId(actorId: string): { role: LlmActorRole; cardId: string | null } {
  for (const role of llmActorRoles) {
    const prefix = `${role}:`;
    if (actorId.startsWith(prefix)) return { role, cardId: role === 'analyst' ? null : actorId.slice(prefix.length) };
  }
  throw new Error(`Expected LLM actor id, received '${actorId}'.`);
}

export function parseProcessorActorId(actorId: string): string {
  if (!actorId.startsWith('processor:')) throw new Error(`Expected processor actor id, received '${actorId}'.`);
  return actorId.slice('processor:'.length);
}
