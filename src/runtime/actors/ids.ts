import { llmActorRoles } from './actor-vocabulary.js';
import type { ActorKind, LlmActorRole } from './actor-vocabulary.js';

export { actorKindSchema, actorKinds, llmActorRoleSchema, llmActorRoles } from './actor-vocabulary.js';
export type { ActorKind, LlmActorRole } from './actor-vocabulary.js';

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

export function cardIdFromSessionId(sessionId: string): string | undefined {
  const reviewerPrefix = 'reviewer:';
  if (sessionId.startsWith(reviewerPrefix)) {
    const rest = sessionId.slice(reviewerPrefix.length);
    const assessmentDelimiter = rest.lastIndexOf(':');
    if (assessmentDelimiter === -1) return rest;
    return rest.slice(0, assessmentDelimiter);
  }
  const parsed = parseLlmActorId(sessionId);
  return parsed.cardId ?? undefined;
}

export function agentIdFromSessionId(sessionId: string): string {
  if (sessionId.startsWith('reviewer:')) {
    const cardId = cardIdFromSessionId(sessionId);
    if (!cardId) throw new Error(`Reviewer session '${sessionId}' is missing a card id.`);
    return reviewerActorId(cardId);
  }
  return sessionId;
}

export function parseProcessorActorId(actorId: string): string {
  if (!actorId.startsWith('processor:')) throw new Error(`Expected processor actor id, received '${actorId}'.`);
  return actorId.slice('processor:'.length);
}
