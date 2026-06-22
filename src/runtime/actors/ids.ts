export type ActorKind = 'supervisor' | 'card' | 'llm' | 'process' | 'processor';

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

export function processActorId(processId: string): string {
  return `process:${processId}`;
}

export function processorActorId(cardId: string): string {
  return `processor:${cardId}`;
}

export function actorKindFromId(actorId: string): ActorKind {
  if (actorId === supervisorActorId()) return 'supervisor';
  if (actorId.startsWith('card:')) return 'card';
  if (actorId.startsWith('planner:') || actorId.startsWith('reviewer:') || actorId.startsWith('executor:')) return 'llm';
  if (actorId.startsWith('process:')) return 'process';
  if (actorId.startsWith('processor:')) return 'processor';
  throw new Error(`Unknown actor id: ${actorId}`);
}
