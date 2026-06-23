import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AtomicJsonFile, ProjectLock } from '../../persistence/index.js';
import { readActorSnapshots } from './snapshots.js';
import type { ActorSnapshotRecord } from './snapshots.js';

export interface ActorRecoveryCardReader {
  read(cardId: string): unknown | null;
  listChildren?(cardId: string): string[];
}

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

export type LlmActorRecoveryPlanRecord = LlmActorRecoveryRecord & { action: LlmRecoveryAction };

export interface ProcessActorRecoveryRecord {
  processId: string;
  snapshot: ActorSnapshotRecord;
  action: ProcessRecoveryAction;
}

export type ProcessRecoveryAction = 'none' | 'abandon_running_process';

export type LlmRecoveryAction = 'none' | 'abandon_provider_call' | 'resume_tool_wait';

export interface ProcessorActorRecoveryRecord {
  actorId: string;
  cardId: string;
  snapshot: ActorSnapshotRecord;
  active: boolean;
}

export interface ActorRecoveryDiagnostic {
  actorId: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface ActorRecoveryDiagnosticAction {
  actorId: string;
  kind: 'active_card' | 'active_llm' | 'llm_recovery_action' | 'active_processor' | 'running_process' | 'discarded_supervisor';
  action: string;
  cardId?: string;
  processId?: string;
}

export interface ActorRecoveryDiagnosticsSnapshot {
  schema_version: 1;
  generated_at: string;
  diagnostics: ActorRecoveryDiagnostic[];
  actions: ActorRecoveryDiagnosticAction[];
}

export interface ActorRecoveryPlan {
  supervisor: ActorSnapshotRecord | null;
  cards: CardActorRecoveryRecord[];
  llms: LlmActorRecoveryPlanRecord[];
  processors: ProcessorActorRecoveryRecord[];
  processes: ProcessActorRecoveryRecord[];
  diagnostics: ActorRecoveryDiagnostic[];
}

export function buildActorRecoveryPlan(projectRoot: string, cards?: ActorRecoveryCardReader): ActorRecoveryPlan {
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
    .map((snapshot): LlmActorRecoveryPlanRecord => {
      const parsed = parseLlmActorId(snapshot.actor_id);
      const active = isActiveLlmSnapshot(snapshot);
      if (active && !knownCardIds.has(parsed.cardId) && !cards?.read(parsed.cardId)) {
        throw new Error(`Cannot recover active LLM actor '${snapshot.actor_id}': owner card '${parsed.cardId}' was not found.`);
      }
      return { actorId: snapshot.actor_id, role: parsed.role, cardId: parsed.cardId, snapshot, active, action: llmRecoveryAction(snapshot) };
    });
  const processors = snapshots
    .filter((snapshot) => snapshot.actor_kind === 'processor')
    .map((snapshot): ProcessorActorRecoveryRecord => ({
      actorId: snapshot.actor_id,
      cardId: parseProcessorActorId(snapshot.actor_id),
      snapshot,
      active: isActiveProcessorSnapshot(snapshot),
    }));
  const processes = snapshots
    .filter((snapshot) => snapshot.actor_kind === 'process')
    .map((snapshot): ProcessActorRecoveryRecord => ({
      processId: parseProcessActorId(snapshot.actor_id),
      snapshot,
      action: processRecoveryAction(snapshot),
    }));
  return {
    supervisor,
    cards: cardRecords.sort((a, b) => a.cardId.localeCompare(b.cardId)),
    llms: llms.sort((a, b) => a.actorId.localeCompare(b.actorId)),
    processors: processors.sort((a, b) => a.actorId.localeCompare(b.actorId)),
    processes: processes.sort((a, b) => a.processId.localeCompare(b.processId)),
    diagnostics: recoveryDiagnostics(supervisor, cardRecords, llms, processors, processes, cards),
  };
}

const recoveryDiagnosticSchema = z.object({
  actorId: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().min(1),
});

const recoveryDiagnosticActionSchema = z.object({
  actorId: z.string().min(1),
  kind: z.enum(['active_card', 'active_llm', 'llm_recovery_action', 'active_processor', 'running_process', 'discarded_supervisor']),
  action: z.string().min(1),
  cardId: z.string().optional(),
  processId: z.string().optional(),
});

const recoveryDiagnosticsSnapshotSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().datetime(),
  diagnostics: z.array(recoveryDiagnosticSchema),
  actions: z.array(recoveryDiagnosticActionSchema),
});

export function recoveryDiagnosticsPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', 'recovery-diagnostics.json');
}

export function readRecoveryDiagnostics(projectRoot: string): ActorRecoveryDiagnosticsSnapshot | null {
  const path = recoveryDiagnosticsPath(projectRoot);
  if (!existsSync(path)) return null;
  return recoveryDiagnosticsFile(projectRoot).read();
}

export function writeRecoveryDiagnostics(projectRoot: string, plan: ActorRecoveryPlan, generatedAt = new Date().toISOString()): ActorRecoveryDiagnosticsSnapshot | null {
  const actions = recoveryDiagnosticActions(plan);
  if (plan.diagnostics.length === 0 && actions.length === 0) {
    clearRecoveryDiagnostics(projectRoot);
    return null;
  }
  const snapshot: ActorRecoveryDiagnosticsSnapshot = {
    schema_version: 1,
    generated_at: generatedAt,
    diagnostics: plan.diagnostics,
    actions,
  };
  const lock = recoveryDiagnosticsLock(projectRoot);
  const file = recoveryDiagnosticsFile(projectRoot, lock);
  lock.withLockSync((handle) => file.writeSync(handle, snapshot));
  return snapshot;
}

export function clearRecoveryDiagnostics(projectRoot: string): void {
  const path = recoveryDiagnosticsPath(projectRoot);
  if (!existsSync(path)) return;
  const lock = recoveryDiagnosticsLock(projectRoot);
  lock.withLockSync(() => {
    if (existsSync(path)) unlinkSync(path);
  });
}

function recoveryDiagnosticsLock(projectRoot: string): ProjectLock {
  return new ProjectLock(join(projectRoot, '.saivage', '.lock'), { staleLockAction: 'remove' });
}

function recoveryDiagnosticsFile(projectRoot: string, lock: ProjectLock = recoveryDiagnosticsLock(projectRoot)): AtomicJsonFile<ActorRecoveryDiagnosticsSnapshot> {
  return new AtomicJsonFile(recoveryDiagnosticsPath(projectRoot), recoveryDiagnosticsSnapshotSchema, lock, { version: null });
}

function recoveryDiagnosticActions(plan: ActorRecoveryPlan): ActorRecoveryDiagnosticAction[] {
  return [
    ...(isNonIdleSupervisorSnapshot(plan.supervisor) ? [{ actorId: 'supervisor', kind: 'discarded_supervisor' as const, action: 'discard_stale_supervisor' }] : []),
    ...plan.cards.filter((card) => card.active).map((card) => ({ actorId: card.snapshot.actor_id, kind: 'active_card' as const, action: 'diagnose_active_card', cardId: card.cardId })),
    ...plan.llms.filter((llm) => llm.active).map((llm) => ({ actorId: llm.actorId, kind: 'active_llm' as const, action: 'diagnose_active_llm', cardId: llm.cardId })),
    ...plan.llms.filter((llm) => llm.action !== 'none').map((llm) => ({ actorId: llm.actorId, kind: 'llm_recovery_action' as const, action: llm.action, cardId: llm.cardId })),
    ...plan.processors.filter((processor) => processor.active).map((processor) => ({ actorId: processor.actorId, kind: 'active_processor' as const, action: 'diagnose_active_processor', cardId: processor.cardId })),
    ...plan.processes.filter((process) => process.action !== 'none').map((process) => ({ actorId: process.snapshot.actor_id, kind: 'running_process' as const, action: process.action, processId: process.processId })),
  ].sort((a, b) => a.actorId.localeCompare(b.actorId) || a.kind.localeCompare(b.kind));
}

function isNonIdleSupervisorSnapshot(snapshot: ActorSnapshotRecord | null): boolean {
  if (!snapshot) return false;
  const state = snapshot.state_value;
  if (typeof state !== 'object' || state === null || !('mode' in state)) return false;
  return (state as { mode?: unknown }).mode !== 'idle';
}

function isActiveCardSnapshot(snapshot: ActorSnapshotRecord): boolean {
  if (snapshot.state_value === 'running') return true;
  return snapshot.context.publicStatus === 'running';
}

function isActiveLlmSnapshot(snapshot: ActorSnapshotRecord): boolean {
  return snapshot.state_value !== 'idle' && snapshot.state_value !== 'done' && snapshot.state_value !== 'cancelled';
}

function isActiveProcessorSnapshot(snapshot: ActorSnapshotRecord): boolean {
  return snapshot.state_value !== 'idle' && snapshot.state_value !== 'settled';
}

function llmRecoveryAction(snapshot: ActorSnapshotRecord): LlmRecoveryAction {
  if (snapshot.state_value === 'calling_provider') return 'abandon_provider_call';
  if (snapshot.state_value === 'waiting_tool') return 'resume_tool_wait';
  return 'none';
}

function processRecoveryAction(snapshot: ActorSnapshotRecord): ProcessRecoveryAction {
  if (snapshot.state_value === 'running' || snapshot.state_value === 'killing') return 'abandon_running_process';
  return 'none';
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

function parseProcessorActorId(actorId: string): string {
  if (!actorId.startsWith('processor:')) throw new Error(`Expected processor actor id, received '${actorId}'.`);
  return actorId.slice('processor:'.length);
}

function recoveryDiagnostics(
  supervisor: ActorSnapshotRecord | null,
  cards: CardActorRecoveryRecord[],
  llms: LlmActorRecoveryPlanRecord[],
  processors: ProcessorActorRecoveryRecord[],
  processes: ProcessActorRecoveryRecord[],
  cardReader?: ActorRecoveryCardReader,
): ActorRecoveryDiagnostic[] {
  return [
    ...(isNonIdleSupervisorSnapshot(supervisor) ? [{ actorId: 'supervisor', severity: 'warning' as const, message: 'Non-idle supervisor snapshot is not resumed; startup creates a fresh supervisor and records this discard.' }] : []),
    ...cards.filter(isAmbiguousActiveCard).map((card) => ({ actorId: card.snapshot.actor_id, severity: 'warning' as const, message: `Active card snapshot has ambiguous state '${String(card.snapshot.state_value)}' and requires explicit recovery reconciliation.` })),
    ...cards.filter((card) => isStrandedActiveCard(card, cards, llms, processors, cardReader)).map((card) => ({ actorId: card.snapshot.actor_id, severity: 'warning' as const, message: 'Active card snapshot has no active processor, LLM, or active child evidence and cannot be safely reconstructed yet.' })),
    ...llms.filter((llm) => llm.action === 'abandon_provider_call').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: 'In-flight provider call cannot be reattached and must be abandoned with a planner-visible diagnostic.' })),
    ...llms.filter((llm) => llm.action === 'resume_tool_wait').map((llm) => ({ actorId: llm.actorId, severity: 'info' as const, message: 'LLM actor is waiting for a persisted tool result and can resume delivery repair.' })),
    ...llms.filter((llm) => llm.active && llm.action === 'none').map((llm) => ({ actorId: llm.actorId, severity: 'warning' as const, message: `Active LLM snapshot state '${String(llm.snapshot.state_value)}' has no concrete recovery action yet.` })),
    ...processors.filter((processor) => processor.active).map((processor) => ({ actorId: processor.actorId, severity: 'warning' as const, message: 'Active processor snapshot requires reconstruction of activation/tool waits before autonomous execution resumes.' })),
    ...processes.filter((process) => process.action === 'abandon_running_process').map((process) => ({ actorId: process.snapshot.actor_id, severity: 'warning' as const, message: 'Running process snapshot is abandoned on startup because live process reattachment is not implemented; rerun the owning tool if the result is still needed.' })),
  ].sort((a, b) => a.actorId.localeCompare(b.actorId));
}

function isAmbiguousActiveCard(card: CardActorRecoveryRecord): boolean {
  return card.active && !isKnownCardActorState(card.snapshot.state_value);
}

function isKnownCardActorState(state: unknown): boolean {
  return state === 'backlog' || state === 'changed' || state === 'blocked' || state === 'failed' || state === 'done' || state === 'cancelled' || state === 'running';
}

function isStrandedActiveCard(
  card: CardActorRecoveryRecord,
  cards: CardActorRecoveryRecord[],
  llms: LlmActorRecoveryPlanRecord[],
  processors: ProcessorActorRecoveryRecord[],
  cardReader?: ActorRecoveryCardReader,
): boolean {
  if (!card.active) return false;
  if (processors.some((processor) => processor.active && processor.cardId === card.cardId)) return false;
  if (llms.some((llm) => llm.active && llm.cardId === card.cardId)) return false;
  const childIds = cardReader?.listChildren?.(card.cardId) ?? [];
  return !childIds.some((childId) => cards.some((candidate) => candidate.cardId === childId && candidate.active));
}
