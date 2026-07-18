import type { ActorPauseMode, LlmActorRole, PublicAgentPhase, PublicCardActorState } from '../../schemas/actor-vocabulary.js';

export type { ActorPauseMode };

export interface CardActorProjection {
  cardId: string;
  actorState: PublicCardActorState;
}

export interface AgentRunnerProjection {
  agentId: string;
  role: LlmActorRole;
  cardId: string | null;
  phase: PublicAgentPhase;
}

export interface ActorRuntimeReadModel {
  pauseMode: ActorPauseMode;
  cards: CardActorProjection[];
  agents: AgentRunnerProjection[];
}
