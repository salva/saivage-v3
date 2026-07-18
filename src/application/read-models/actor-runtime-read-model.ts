import type { ActorPauseMode, PublicCardActorState } from '../../schemas/actor-vocabulary.js';

export type { ActorPauseMode };

export interface CardActorProjection {
  cardId: string;
  actorState: PublicCardActorState;
}

export interface ActorRuntimeReadModel {
  pauseMode: ActorPauseMode;
  cards: CardActorProjection[];
}
