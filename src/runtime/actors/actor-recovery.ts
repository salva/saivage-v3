import { readActorSnapshots } from './snapshots.js';
import type { ActorSnapshotRecord } from './snapshots.js';
import type { XStateChildCardReader } from './xstate-child-activation.js';

export type LlmRecoveryRole = 'planner' | 'reviewer' | 'executor';

export interface CardActorRecoveryRecord {
  cardId: string;
  snapshot: ActorSnapshotRecord;
  active: boolean;
}

export interface LlmActorRecoveryRecord {
  actorId: string;
  role: LlmRecoveryRole;
  cardId: string;
  snapshot: ActorSnapshotRecord;
  active: boolean;
}

export interface ProcessActorRecoveryRecord {
  processId: string;
  snapshot: ActorSnapshotRecord;
  requiresReconciliation: boolean;
}

export interface ActorRecoveryPlan {
  supervisor: ActorSnapshotRecord | null;
  cards: CardActorRecoveryRecord[];
  llms: LlmActorRecoveryRecord[];
  processes: ProcessActorRecoveryRecord[];
}

export function buildActorRecoveryPlan(projectRoot: string, cards?: XStateChildCardReader): ActorRecoveryPlan {
  const snapshots = readActorSnapshots(projectRoot);
  const supervisor = snapshots.find((snapshot) => snapshot.actor_id === 'supervisor') ?? null;
  const cardSnapshots = snapshots.filter((snapshot) => snapshot.actor_kind === 'card');
  const knownCardIds = new Set<string>();
  const cardRecords = cardSnapshots.map((snapshot): CardActorRecoveryRecord => {
    const cardId = parseCardActorId(snapshot.actor_id);
    knownCardIds.add(cardId);
    return { cardId, snapshot, active: isActiveCardSnapshot(snapshot) };
  });
  const llms = snapshots
    .filter((snapshot) => snapshot.actor_kind === 'llm')
    .map((snapshot): LlmActorRecoveryRecord => {
      const parsed = parseLlmActorId(snapshot.actor_id);
      const active = snapshot.state_value !== 'done';
      if (active && !knownCardIds.has(parsed.cardId) && !cards?.read(parsed.cardId)) {
        throw new Error(`Cannot recover active LLM actor '${snapshot.actor_id}': owner card '${parsed.cardId}' was not found.`);
      }
      return { actorId: snapshot.actor_id, role: parsed.role, cardId: parsed.cardId, snapshot, active };
    });
  const processes = snapshots
    .filter((snapshot) => snapshot.actor_kind === 'process')
    .map((snapshot): ProcessActorRecoveryRecord => ({
      processId: parseProcessActorId(snapshot.actor_id),
      snapshot,
      requiresReconciliation: snapshot.state_value === 'running',
    }));
  return {
    supervisor,
    cards: cardRecords.sort((a, b) => a.cardId.localeCompare(b.cardId)),
    llms: llms.sort((a, b) => a.actorId.localeCompare(b.actorId)),
    processes: processes.sort((a, b) => a.processId.localeCompare(b.processId)),
  };
}

function isActiveCardSnapshot(snapshot: ActorSnapshotRecord): boolean {
  if (snapshot.state_value !== 'done') return true;
  return snapshot.context.publicStatus === 'running';
}

function parseCardActorId(actorId: string): string {
  if (!actorId.startsWith('card:')) throw new Error(`Expected card actor id, received '${actorId}'.`);
  return actorId.slice('card:'.length);
}

function parseLlmActorId(actorId: string): { role: LlmRecoveryRole; cardId: string } {
  for (const role of ['planner', 'reviewer', 'executor'] as const) {
    const prefix = `${role}:`;
    if (actorId.startsWith(prefix)) return { role, cardId: actorId.slice(prefix.length) };
  }
  throw new Error(`Expected LLM actor id, received '${actorId}'.`);
}

function parseProcessActorId(actorId: string): string {
  if (!actorId.startsWith('process:')) throw new Error(`Expected process actor id, received '${actorId}'.`);
  return actorId.slice('process:'.length);
}
