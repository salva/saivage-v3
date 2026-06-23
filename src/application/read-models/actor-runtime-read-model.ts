import { readActorSnapshots } from '../../runtime/actors/index.js';

export type ActorPauseMode = 'running' | 'paused' | 'stopping' | 'unknown';

export interface CardActorProjection {
  cardId: string;
  actorState: string;
}

export interface AgentRunnerProjection {
  agentId: string;
  agentPhase: string;
}

export interface ActorRuntimeReadModel {
  pauseMode: ActorPauseMode;
  cards: CardActorProjection[];
  agents: AgentRunnerProjection[];
  diagnostics: string[];
}

export function buildActorRuntimeReadModel(projectRoot: string): ActorRuntimeReadModel {
  const snapshots = readActorSnapshots(projectRoot);
  const diagnostics: string[] = [];
  let pauseMode: ActorPauseMode = 'unknown';
  const cards: CardActorProjection[] = [];
  const agents: AgentRunnerProjection[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.actor_kind === 'supervisor') {
      pauseMode = readSupervisorMode(snapshot.state_value, diagnostics);
      continue;
    }
    if (snapshot.actor_kind === 'card') {
      cards.push({ cardId: stripRequiredPrefix(snapshot.actor_id, 'card:', diagnostics), actorState: readCardActorState(snapshot.actor_id, snapshot.state_value, diagnostics) });
      continue;
    }
    if (snapshot.actor_kind === 'llm') {
      agents.push({ agentId: snapshot.actor_id, agentPhase: readAgentPhase(snapshot.actor_id, snapshot.state_value, diagnostics) });
    }
  }

  return {
    pauseMode,
    cards: cards.sort((a, b) => a.cardId.localeCompare(b.cardId)),
    agents: agents.sort((a, b) => a.agentId.localeCompare(b.agentId)),
    diagnostics,
  };
}

function readCardActorState(actorId: string, value: unknown, diagnostics: string[]): string {
  if (value === 'backlog' || value === 'changed' || value === 'running' || value === 'blocked' || value === 'failed' || value === 'done' || value === 'cancelled') return value;
  diagnostics.push(`card actor '${actorId}' has unknown state '${String(value)}'`);
  return 'unknown';
}

function readAgentPhase(actorId: string, value: unknown, diagnostics: string[]): string {
  if (value === 'running' || value === 'done') return value;
  diagnostics.push(`agent actor '${actorId}' has unknown phase '${String(value)}'`);
  return 'unknown';
}

function readSupervisorMode(value: unknown, diagnostics: string[]): ActorPauseMode {
  if (!value || typeof value !== 'object' || !('mode' in value)) {
    diagnostics.push('supervisor snapshot is missing mode region');
    return 'unknown';
  }
  const mode = (value as { mode: unknown }).mode;
  if (mode === 'idle') return 'running';
  if (mode === 'running' || mode === 'paused' || mode === 'stopping') return mode;
  diagnostics.push(`supervisor snapshot has unknown mode '${String(mode)}'`);
  return 'unknown';
}

function stripRequiredPrefix(value: string, prefix: string, diagnostics: string[]): string {
  if (value.startsWith(prefix)) return value.slice(prefix.length);
  diagnostics.push(`actor id '${value}' is missing expected '${prefix}' prefix`);
  return value;
}
