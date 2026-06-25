import { readActorSnapshots, readRecoveryDiagnostics, type ActorRecoveryDiagnostic, type ActorRecoveryDiagnosticAction } from '../../runtime/actors/index.js';
import { parseCardActorId, parseLlmActorId, readSupervisorModeValue, readSupervisorWorkValue, toPublicAgentPhase, toPublicCardActorState } from '../../runtime/actors/index.js';
import type { LlmActorRole, PublicAgentPhase, PublicCardActorState } from '../../runtime/actors/index.js';

export type ActorPauseMode = 'running' | 'paused' | 'stopping' | 'unknown';
export type ActorActiveWork = 'none' | 'model_invocation' | 'shutdown' | 'unknown';

export interface CardActorProjection {
  cardId: string;
  actorState: PublicCardActorState;
}

export interface AgentRunnerProjection {
  agentId: string;
  role: LlmActorRole;
  cardId: string;
  phase: PublicAgentPhase;
}

export interface RecoveryDiagnosticsProjection {
  generated_at: string;
  diagnostics: ActorRecoveryDiagnostic[];
  actions: ActorRecoveryDiagnosticAction[];
}

export interface ActorRuntimeReadModel {
  pauseMode: ActorPauseMode;
  activeWork: ActorActiveWork;
  cards: CardActorProjection[];
  agents: AgentRunnerProjection[];
  diagnostics: string[];
  recovery: RecoveryDiagnosticsProjection | null;
}

export function buildActorRuntimeReadModel(projectRoot: string): ActorRuntimeReadModel {
  const snapshots = readActorSnapshots(projectRoot);
  const diagnostics: string[] = [];
  let pauseMode: ActorPauseMode = 'unknown';
  let activeWork: ActorActiveWork = 'unknown';
  const cards: CardActorProjection[] = [];
  const agents: AgentRunnerProjection[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.actor_kind === 'supervisor') {
      pauseMode = readSupervisorMode(snapshot.state_value, diagnostics);
      activeWork = readSupervisorActiveWork(snapshot.state_value, diagnostics);
      continue;
    }
    if (snapshot.actor_kind === 'card') {
      cards.push({ cardId: readCardActorId(snapshot.actor_id, diagnostics), actorState: toPublicCardActorState(snapshot.state_value) });
      continue;
    }
    if (snapshot.actor_kind === 'llm') {
      agents.push(readAgent(snapshot.actor_id, snapshot.state_value));
    }
  }

  return {
    pauseMode,
    activeWork,
    cards: cards.sort((a, b) => a.cardId.localeCompare(b.cardId)),
    agents: agents.sort((a, b) => a.agentId.localeCompare(b.agentId)),
    diagnostics,
    recovery: recoveryProjection(projectRoot),
  };
}

function recoveryProjection(projectRoot: string): RecoveryDiagnosticsProjection | null {
  const snapshot = readRecoveryDiagnostics(projectRoot);
  if (!snapshot) return null;
  return { generated_at: snapshot.generated_at, diagnostics: snapshot.diagnostics, actions: snapshot.actions };
}

function readAgent(actorId: string, value: unknown): AgentRunnerProjection {
  const parsed = parseLlmActorId(actorId);
  return { agentId: actorId, role: parsed.role, cardId: parsed.cardId, phase: toPublicAgentPhase(value) };
}

function readSupervisorMode(value: unknown, diagnostics: string[]): ActorPauseMode {
  if (!value || typeof value !== 'object' || !('mode' in value)) {
    diagnostics.push('supervisor snapshot is missing mode region');
    return 'unknown';
  }
  const mode = readSupervisorModeValue(value);
  if (mode === 'idle') return 'running';
  if (mode === 'running' || mode === 'paused') return mode;
  if (mode === 'shutting_down') return 'stopping';
  diagnostics.push(`supervisor snapshot has unknown mode '${String((value as { mode: unknown }).mode)}'`);
  return 'unknown';
}

function readSupervisorActiveWork(value: unknown, diagnostics: string[]): ActorActiveWork {
  if (!value || typeof value !== 'object' || !('work' in value)) {
    diagnostics.push('supervisor snapshot is missing active work region');
    return 'unknown';
  }
  const work = readSupervisorWorkValue(value);
  if (work === 'ready') return 'none';
  if (work === 'model_invocation_active') return 'model_invocation';
  if (work === 'shutdown_active') return 'shutdown';
  diagnostics.push(`supervisor snapshot has unknown active work '${String((value as { work: unknown }).work)}'`);
  return 'unknown';
}

function readCardActorId(value: string, diagnostics: string[]): string {
  try {
    return parseCardActorId(value);
  } catch {
    diagnostics.push(`actor id '${value}' is missing expected 'card:' prefix`);
  }
  return value;
}
