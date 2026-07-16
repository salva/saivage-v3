import type { ActorPauseMode, LlmActorRole, PublicAgentPhase, PublicCardActorState } from '../../schemas/actor-vocabulary.js';

export type { ActorPauseMode };
export type ActorActiveWork = 'none' | 'model_invocation' | 'shutdown' | 'unknown';

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
  activeWork: ActorActiveWork;
  cards: CardActorProjection[];
  agents: AgentRunnerProjection[];
  diagnostics: string[];
}
