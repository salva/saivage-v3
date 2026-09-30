import type { ActorPauseMode, PublicCardActorState } from '../../schemas/index.js';
import type { ProcessPosition } from '../../runtime/runtime-api.js';

interface CardActorProjection {
  cardId: string;
  actorState: PublicCardActorState;
  processState: ProcessPosition | null;
}

export interface ActorRuntimeReadModel {
  pauseMode: ActorPauseMode;
  cards: CardActorProjection[];
}
