import { readActorSnapshots, readRecoveryDiagnostics, type ActorRecoveryDiagnostic, type ActorRecoveryDiagnosticAction } from '../../runtime/actors/index.js';
import { parseCardActorId, parseLlmActorId } from '../../runtime/actors/index.js';
import { toPublicAgentPhase, toPublicCardActorState } from '../../schemas/actor-vocabulary.js';
import type { ActorPauseMode, LlmActorRole, PublicAgentPhase, PublicCardActorState } from '../../schemas/actor-vocabulary.js';
import { CardStore } from '../../cards/card-store.js';
import { readRuntimeState } from '../../runtime/state-api.js';
import type { RuntimeStatus } from '../../schemas/index.js';

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
  const runtimeStatus = readRuntimeState(projectRoot)?.status ?? null;
  const pauseMode = pauseModeFromRuntimeStatus(runtimeStatus);
  const activeWork = activeWorkFromRuntimeStatus(runtimeStatus);
  const cards: CardActorProjection[] = [];
  const agents: AgentRunnerProjection[] = [];
  const cardStore = new CardStore(projectRoot);

  for (const snapshot of snapshots) {
    if (snapshot.actor_kind === 'card') {
      const cardId = readCardActorId(snapshot.actor_id, diagnostics);
      const card = cardStore.read(cardId);
      if (!card) diagnostics.push(`card actor snapshot '${snapshot.actor_id}' has no matching card record`);
      else cards.push({ cardId, actorState: toPublicCardActorState(card.status) });
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

function readCardActorId(value: string, diagnostics: string[]): string {
  try {
    return parseCardActorId(value);
  } catch {
    diagnostics.push(`actor id '${value}' is missing expected 'card:' prefix`);
  }
  return value;
}

function pauseModeFromRuntimeStatus(status: RuntimeStatus | null): ActorPauseMode {
  if (status === 'running') return 'running';
  if (status === 'paused') return 'paused';
  if (status === 'stopped') return 'idle';
  return 'unknown';
}

function activeWorkFromRuntimeStatus(status: RuntimeStatus | null): ActorActiveWork {
  if (status === 'running' || status === 'paused' || status === 'stopped') return 'none';
  return 'unknown';
}
